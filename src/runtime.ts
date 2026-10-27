/**
 * Client for the Rust sandboxed host (`xharness-feishu`, POST /tasks).
 *
 * Why a separate process instead of doing the work in-process:
 *
 *  - The Rust host runs every tool inside a bubblewrap sandbox (workspace
 *    writable, host read-only, no network). Node has no equivalent guarantee,
 *    and a `bash` tool running as the bot's own user would be effectively
 *    unrestricted on this machine.
 *  - The host is a long-running task service: submit returns a session id and
 *    the result is polled. That fits the 3-second Feishu event budget, which
 *    cannot accommodate a task that compiles code for two minutes.
 *
 * The allowlist lives here, not in the Rust service, because authorisation is a
 * chat concern: the host is bound to loopback and trusts whoever reaches it.
 */
import { randomUUID } from "node:crypto";

export interface RuntimeConfig {
  /** Base URL, e.g. http://127.0.0.1:3082 */
  baseUrl: string;
  /** Bearer token; empty when the host has no secret configured. */
  secret?: string;
  /** open_id values allowed to drive the sandbox. Empty = nobody. */
  allowlist: string[];
  /** Hard ceiling for one task, including the whole agent loop. */
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface RuntimeResult {
  status: string;
  finalText: string;
}

export class RuntimeError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "RuntimeError";
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_MS = 1_500;

export class SandboxRuntime {
  #config: Required<Omit<RuntimeConfig, "secret">> & { secret: string };
  /**
   * 每个 chat 的"代"。重置时 +1，并作为 workspace 名传给 host ——
   * host 的 session_id 由 (chat_id, workspace) 派生，所以换 workspace
   * 就等于换一个新会话，不需要 Rust 侧提供专门的 reset 接口。
   */
  #generation = new Map<string, number>();

  constructor(config: RuntimeConfig) {
    this.#config = {
      baseUrl: config.baseUrl.replace(/\/+$/, ""),
      secret: config.secret ?? "",
      allowlist: config.allowlist,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_MS,
    };
  }

  /**
   * Authorisation is deny-by-default: an empty allowlist means nobody, not
   * everybody. A misconfigured env var must fail closed.
   */
  isAllowed(openId: string | undefined): boolean {
    if (!openId) return false;
    return this.#config.allowlist.includes(openId);
  }

  get configured(): boolean {
    return this.#config.baseUrl.length > 0 && this.#config.allowlist.length > 0;
  }

  get allowlistSize(): number {
    return this.#config.allowlist.length;
  }

  /** 忘掉这个 chat 的会话：下一代 workspace 会拿到全新的 session。 */
  reset(chatId: string): void {
    this.#generation.set(chatId, (this.#generation.get(chatId) ?? 0) + 1);
  }

  /** 当前会话的 workspace 名，仅用于日志/排查。 */
  workspaceFor(chatId: string): string {
    const gen = this.#generation.get(chatId) ?? 0;
    return gen === 0 ? chatId : `${chatId}-g${gen}`;
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#config.secret) headers["authorization"] = `Bearer ${this.#config.secret}`;

    let response: Response;
    try {
      response = await fetch(`${this.#config.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new RuntimeError(`sandbox unreachable: ${reason}`);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new RuntimeError(
        `sandbox rejected task (${response.status}): ${text.slice(0, 200)}`,
        response.status,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new RuntimeError("sandbox returned non-JSON");
    }
  }

  async #get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.#config.secret) headers["authorization"] = `Bearer ${this.#config.secret}`;
    const response = await fetch(`${this.#config.baseUrl}${path}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    return (await response.json()) as T;
  }

  /** Cheap liveness probe, used by the doctor. */
  async health(): Promise<boolean> {
    try {
      const body = await this.#get<{ ok?: boolean }>("/health");
      return body.ok === true;
    } catch {
      return false;
    }
  }

  /**
   * Submit a task and wait for its result.
   *
   * `messageId` is passed through as the idempotency key: Feishu retries the
   * same event when a handler is slow, and the Rust host records the turn under
   * a durable id derived from it, so a retry does not run the task twice.
   */
  async run(options: {
    chatId: string;
    messageId: string;
    text: string;
    systemPrompt?: string;
  }): Promise<RuntimeResult> {
    const body = {
      chat_id: options.chatId,
      message_id: options.messageId,
      text: options.text,
      system_prompt: options.systemPrompt,
      // 重置后递增的代会让 host 侧派生新的 session。
      workspace: this.workspaceFor(options.chatId),
      // Unique per submission attempt, so two genuinely different messages with
      // the same id (different chat) cannot collide.
      message_tag: randomUUID().slice(0, 8),
    };

    const accepted = await this.#post<{ sessionId?: string; error?: string }>("/tasks", body);
    const sessionId = accepted.sessionId;
    if (!sessionId) {
      throw new RuntimeError(accepted.error ?? "sandbox returned no sessionId");
    }

    const deadline = Date.now() + this.#config.timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.#get<RuntimeResult>(`/results/${encodeURIComponent(sessionId)}`);
      if (result.status !== "unknown") return result;
      await new Promise((resolve) => setTimeout(resolve, this.#config.pollIntervalMs));
    }
    throw new RuntimeError(
      `sandbox task timed out after ${Math.round(this.#config.timeoutMs / 1000)}s`,
    );
  }
}

export function runtimeFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxRuntime | null {
  const baseUrl = env.SANDBOX_BASE_URL?.trim();
  if (!baseUrl) return null;
  const allowlist = (env.SANDBOX_ALLOWLIST ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return new SandboxRuntime({
    baseUrl,
    secret: env.SANDBOX_SECRET?.trim() || undefined,
    allowlist,
    timeoutMs: env.SANDBOX_TIMEOUT_MS ? Number(env.SANDBOX_TIMEOUT_MS) : undefined,
  });
}
