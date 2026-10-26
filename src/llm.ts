/**
 * DeepSeek chat completion client (OpenAI-compatible /chat/completions).
 *
 * Security rules enforced here, not by convention:
 *   * the API key is read from the environment and never logged, echoed, or
 *     included in an error message — `redact()` runs over everything that
 *     leaves this module;
 *   * request bodies are never dumped to the journal (a user's prompt can be
 *     sensitive too);
 *   * a missing key is not an error at import time, so the bot still runs
 *     without one and falls back to a plain echo.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Llm {
  chat(messages: ChatMessage[]): Promise<string>;
}

export class LlmError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "LlmError";
    this.status = status;
  }
}

export interface DeepSeekOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  fetchImpl?: typeof fetch;
}

/** Remove anything that looks like the key from a message we are about to log. */
export function redact(text: string, apiKey: string): string {
  if (!apiKey) return text;
  let out = text.split(apiKey).join("sk-***redacted***");
  // Also catch a truncated echo of the same credential.
  const tail = apiKey.slice(-8);
  if (tail.length >= 8) out = out.split(tail).join("***redacted***");
  return out;
}

export class DeepSeek implements Llm {
  #apiKey: string;
  #baseUrl: string;
  #model: string;
  #timeoutMs: number;
  #maxTokens: number;
  #temperature: number;
  #fetch: typeof fetch;

  constructor(options: DeepSeekOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, "");
    this.#model = options.model ?? "deepseek-chat";
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#maxTokens = options.maxTokens ?? 800;
    this.#temperature = options.temperature ?? 0.7;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  get model(): string {
    return this.#model;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const body = JSON.stringify({
      model: this.#model,
      messages,
      stream: false,
      temperature: this.#temperature,
      max_tokens: this.#maxTokens,
    });

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#apiKey}`,
        },
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new LlmError(redact(`request failed: ${reason}`, this.#apiKey));
    }

    const raw = await response.text();
    if (!response.ok) {
      // The provider may quote the key back in its error; redact before throwing.
      throw new LlmError(
        redact(`http ${response.status}: ${raw.slice(0, 300)}`, this.#apiKey),
        response.status,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new LlmError("response was not JSON");
    }
    const content = (parsed as { choices?: Array<{ message?: { content?: string } }> })
      .choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new LlmError("response had no content");
    }
    return content.trim();
  }
}

/** Read the DeepSeek settings from the environment; null when unconfigured. */
export function deepSeekFromEnv(env: NodeJS.ProcessEnv = process.env): DeepSeek | null {
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) return null;
  return new DeepSeek({
    apiKey,
    baseUrl: env.DEEPSEEK_BASE_URL?.trim() || undefined,
    model: env.DEEPSEEK_MODEL?.trim() || undefined,
    maxTokens: env.DEEPSEEK_MAX_TOKENS ? Number(env.DEEPSEEK_MAX_TOKENS) : undefined,
  });
}
