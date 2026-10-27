/**
 * The bot's behaviour, extracted from the entry point so it can be tested with
 * a fake model instead of a live API call.
 *
 * Note the ordering trap this factory exists to avoid: reading the model config
 * at module scope runs *before* .env is loaded, which silently leaves the key
 * unset and the bot in echo mode. Everything that depends on the environment is
 * built here, after the caller has loaded it.
 */
import type { Incoming, Reply } from "./bot.ts";
import { History } from "./history.ts";
import { LlmError, redact } from "./llm.ts";
import type { Dialogue } from "./machine.ts";
import type { Llm } from "./llm.ts";

export const DEFAULT_SYSTEM_PROMPT = [
  "你是一个运行在飞书里的助手。",
  "回答简洁、直接，用中文。",
  "不确定的事就说不确定，不要编造。",
  "代码用 markdown 代码块。",
].join("\n");

export interface HandlerOptions {
  llm: Llm | null;
  history?: History;
  systemPrompt?: string;
  /** Absolute path of the demo image used by the `图` command. */
  imagePath?: string;
  logger?: Pick<Console, "info" | "error">;
  /** Secret to scrub from anything logged. */
  secret?: string;
  /**
   * Optional dialogue machine. Anything it reports as handled never reaches the
   * model, which is what keeps multi-step flows deterministic.
   */
  dialogue?: Dialogue;
}

const IMAGE_WORDS = new Set(["图", "图片", "image", "pic"]);
const RESET_WORDS = new Set(["清空", "重置", "reset", "/reset", "/clear"]);
const NOT_CONFIGURED = "\n\n（未配置 DEEPSEEK_API_KEY，当前是回显模式）";

export function createHandler(options: HandlerOptions) {
  const history = options.history ?? new History();
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const logger = options.logger ?? console;
  const secret = options.secret ?? "";
  const { llm } = options;

  return async function handler(message: Incoming): Promise<Reply | null> {
    if (message.msgType !== "text") {
      return { kind: "text", text: `暂时只处理文本消息（收到 ${message.msgType}）。` };
    }

    const text = message.text;
    const command = text.toLowerCase();

    if (!text) return { kind: "text", text: "在，说点什么？" };
    if (command === "ping") return { kind: "text", text: "pong" };
    if (IMAGE_WORDS.has(command) && options.imagePath) {
      return { kind: "image", source: options.imagePath };
    }
    if (RESET_WORDS.has(command)) {
      history.clear(message.chatId);
      options.dialogue?.clear(message.chatId);
      return { kind: "text", text: "已清空这个会话的上下文。" };
    }

    // Multi-step flows take precedence over the model: while a flow is asking
    // for a slot, sending the answer to the model would ignore the question.
    if (options.dialogue) {
      const step = await options.dialogue.step(message.chatId, text);
      if (step.handled) {
        return step.reply ? { kind: "text", text: step.reply } : null;
      }
    }

    if (!llm) {
      return { kind: "text", text: `收到：${text}${NOT_CONFIGURED}` };
    }

    try {
      const answer = await llm.chat([
        { role: "system", content: systemPrompt },
        ...history.get(message.chatId),
        { role: "user", content: text },
      ]);
      history.add(message.chatId, text, answer);
      return { kind: "text", text: answer };
    } catch (error) {
      const detail = error instanceof LlmError ? error.message : "unexpected error";
      // Redact before logging: provider errors sometimes quote the credential.
      logger.error(`llm failed: ${redact(detail, secret)}`);
      return { kind: "text", text: "模型暂时不可用，稍后再试。" };
    }
  };
}
