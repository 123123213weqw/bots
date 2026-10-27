/**
 * A small dialogue state machine.
 *
 * Why an explicit machine rather than another branch in handler.ts: a multi-step
 * flow ("ask for a repo name", "wait for confirmation") is state, and encoding
 * state in a chain of if-statements means the state lives in the order of the
 * statements instead of in data you can inspect, test and time out.
 *
 * The failure mode this is built around: a conversation state machine that
 * captures a chat and never lets go. Someone types "查仓库", walks away, and the
 * next thing they ask gets answered with "请发送 owner/repo" forever. So a state
 * always has a TTL, there is always a global cancel, and -- importantly -- an
 * unmatched message in a flow does NOT mean the flow owns the chat: it replies
 * with a hint and still lets an explicit command through.
 */
import { LruCache } from "./util.ts";

export type StateName = string;

export interface StepContext {
  chatId: string;
  text: string;
  /** Slots collected so far in this flow. */
  data: Record<string, string>;
  now: number;
}

export interface Transition {
  /** "*" matches in any state, including the initial one (flow triggers). */
  from: "*" | StateName[];
  /** A regexp (matched against the trimmed text) or a predicate. */
  match: RegExp | ((ctx: StepContext) => boolean);
  to: StateName;
  /** Static text or a function of the context. */
  reply?: string | ((ctx: StepContext) => string);
  /** Store something in `data`. Defaults to the whole text. */
  capture?: { key: string; group?: number };
  /**
   * Side effect. Its return value, if a string, replaces `reply`; returning
   * undefined keeps the configured one. Runs only when everything else matched.
   */
  action?: (ctx: StepContext) => Promise<string | void> | string | void;
}

export interface StateSpec {
  /** What the bot says on entering this state, unless the transition set a reply. */
  prompt?: string;
  /** Auto-abandon the flow after this long without a matching message. */
  ttlMs?: number;
}

export interface MachineDef {
  initial: StateName;
  states: Record<StateName, StateSpec>;
  transitions: Transition[];
  /** Always abort an active flow (not checked in the initial state). */
  cancel?: RegExp;
  /** Reply in a flow when nothing matched. */
  onUnmatched?: string;
  /** Default TTL when a state does not set one. */
  defaultTtlMs?: number;
}

export interface Session {
  state: StateName;
  data: Record<string, string>;
  enteredAt: number;
}

export interface StepResult {
  /** False means "no flow owns this message" and the caller should handle it. */
  handled: boolean;
  reply?: string;
  state: StateName;
  /** True when a timed-out or cancelled flow was dropped by this call. */
  reset?: boolean;
}

const DEFAULT_TTL_MS = 5 * 60_000;

export class Dialogue {
  #def: MachineDef;
  #sessions: LruCache<Session>;
  #now: () => number;

  constructor(def: MachineDef, options: { chats?: number; now?: () => number } = {}) {
    this.#def = def;
    this.#sessions = new LruCache<Session>(options.chats ?? 500);
    this.#now = options.now ?? Date.now;
  }

  /** Current state for a chat, for tests and for `/status`. */
  peek(chatId: string): Session | undefined {
    return this.#sessions.get(chatId);
  }

  get size(): number {
    return this.#sessions.size;
  }

  /** Drop a chat's flow (the reset command). */
  clear(chatId: string): void {
    this.#sessions.delete(chatId);
  }

  /**
   * Advance the machine by one message.
   *
   * Order matters: expire, then cancel, then transitions, then unmatched.
   */
  async step(
    chatId: string,
    text: string,
    now: number = this.#now(),
  ): Promise<StepResult> {
    const initial = this.#def.initial;
    let session = this.#sessions.get(chatId);

    // 1. Expire an abandoned flow before anything else, so a stale session can
    //    never shadow a fresh trigger.
    let reset = false;
    if (session && session.state !== initial && this.#expired(session, now)) {
      this.#sessions.delete(chatId);
      session = undefined;
      reset = true;
    }

    // Captured once so the narrowing survives later reassignment of `session`.
    const inFlow = session !== undefined && session.state !== initial;
    const active = inFlow ? session : undefined;

    // 2. Cancel.
    if (active && this.#def.cancel?.test(text.trim())) {
      this.#sessions.delete(chatId);
      return { handled: true, reply: "已取消。", state: initial, reset: true };
    }

    const ctx: StepContext = {
      chatId,
      text: text.trim(),
      data: { ...(session?.data ?? {}) },
      now,
    };

    // 3. Transitions, first match wins. Wildcards are the way a flow starts, so
    //    they are evaluated in the same pass as the state's own transitions.
    for (const t of this.#def.transitions) {
      if (t.from !== "*" && !t.from.includes(session?.state ?? initial)) continue;
      if (!this.#matches(t, ctx)) continue;

      if (t.capture) {
        const value = this.#capture(t, ctx);
        if (value === undefined) continue;
        ctx.data[t.capture.key] = value;
      }

      const acted = t.action ? await t.action(ctx) : undefined;
      const reply =
        (typeof acted === "string" ? acted : undefined) ??
        (typeof t.reply === "function" ? t.reply(ctx) : t.reply) ??
        this.#def.states[t.to]?.prompt;

      const next: Session = {
        state: t.to,
        data: ctx.data,
        enteredAt: now,
      };
      if (t.to === initial) this.#sessions.delete(chatId);
      else this.#sessions.set(chatId, next);

      return { handled: true, reply, state: t.to, reset };
    }

    // 4. In a flow with no match: hint, but stay put. The message is consumed so
    //    it is not also sent to the model, which would produce an answer that
    //    ignores the question the flow just asked.
    if (active) {
      this.#sessions.set(chatId, { ...active, enteredAt: now });
      return {
        handled: true,
        reply: this.#def.onUnmatched ?? "没听懂，可以发「取消」退出。",
        state: active.state,
      };
    }

    return { handled: false, state: initial, reset };
  }

  #expired(session: Session, now: number): boolean {
    const ttl = this.#def.states[session.state]?.ttlMs
      ?? this.#def.defaultTtlMs
      ?? DEFAULT_TTL_MS;
    return now - session.enteredAt > ttl;
  }

  #matches(t: Transition, ctx: StepContext): boolean {
    if (typeof t.match === "function") return t.match(ctx);
    // RegExp with /g keeps state between calls; reset before testing.
    t.match.lastIndex = 0;
    return t.match.test(ctx.text);
  }

  #capture(t: Transition, ctx: StepContext): string | undefined {
    if (!t.capture) return undefined;
    const group = t.capture.group ?? 0;
    if (typeof t.match === "function") return group === 0 ? ctx.text : undefined;
    t.match.lastIndex = 0;
    const m = t.match.exec(ctx.text);
    if (!m) return undefined;
    return m[group];
  }
}
