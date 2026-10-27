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
import type { SandboxRuntime } from "./runtime.ts";
import { LruCache } from "./util.ts";
import {
  FileError,
  assertFileSize,
  classify,
  formatFileOverview,
  sanitizeFileName,
  summarizeText,
} from "./files.ts";
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
  /**
   * Fetches an uploaded resource. Injected so the handler stays testable and
   * does not need the SDK to exercise file paths.
   */
  downloadFile?: (messageId: string, fileKey: string) => Promise<Buffer>;
  /**
   * Sandboxed Rust host. Only reachable for open_ids on its allowlist; the
   * check lives in the runtime, but the reply text here makes a refusal
   * explicit instead of silently falling back to chat.
   */
  sandbox?: SandboxRuntime | null;
  /** Command prefix that routes a message into the sandbox. */
  sandboxTrigger?: RegExp;
}

const SANDBOX_COMMANDS = /^(?:沙箱|sandbox|跑|run|执行)\s+([\s\S]+)$/i;
const SANDBOX_HELP =
  "沙箱用法：`沙箱 <任务>`，例如 `沙箱 统计 src 下有多少个 ts 文件`。\n" +
  "任务在隔离环境里执行（workspace 可写、宿主只读、断网）。";

/** The last uploaded text file per chat, so a follow-up question can use it. */
interface PendingFile {
  name: string;
  text: string;
  at: number;
}

const PENDING_TTL_MS = 10 * 60_000;
const PENDING_MAX_CHARS = 60_000;
/**
 * Intents that should consume the last uploaded file.
 *
 * `\b` is deliberately absent from the CJK branch: a word boundary requires a
 * \w character on one side, and CJK code points are not \w, so `分析\b` never
 * matches "分析一下". English keeps the boundary so "analyzed" does not trigger.
 */
const ANALYSE = /^(?:分析|总结|解释|看看|摘要|解读)|^(?:summari[sz]e|analy[sz]e)\b/i;

const IMAGE_WORDS = new Set(["图", "图片", "image", "pic"]);
const RESET_WORDS = new Set(["清空", "重置", "reset", "/reset", "/clear"]);
const NOT_CONFIGURED = "\n\n（未配置 DEEPSEEK_API_KEY，当前是回显模式）";

export function createHandler(options: HandlerOptions) {
  const history = options.history ?? new History();
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const logger = options.logger ?? console;
  const secret = options.secret ?? "";
  const { llm } = options;
  const pending = new LruCache<PendingFile>(200);

  async function handleFile(message: Incoming): Promise<Reply> {
    const name = sanitizeFileName(message.fileName);
    if (!message.fileKey) {
      return { kind: "text", text: `${name}：这条文件消息没有可用的资源 key。` };
    }
    if (!options.downloadFile) {
      return { kind: "text", text: "当前未启用文件下载（缺少 downloadFile 注入）。" };
    }

    let buffer: Buffer;
    try {
      buffer = await options.downloadFile(message.messageId, message.fileKey);
      assertFileSize(buffer.byteLength);
    } catch (error) {
      const reason = error instanceof FileError ? error.message : "下载失败";
      logger.error(`file rejected name=${name} reason=${reason}`);
      return { kind: "text", text: `无法处理 ${name}：${reason}` };
    }

    const kind = classify(name, buffer);
    if (kind !== "text") {
      const note =
        kind === "pdf" || kind === "archive"
          ? "\n需要解析正文的话，把内容复制成文本再发我，或告诉我你想提取什么。"
          : kind === "image"
            ? "\n图片请用「图」相关命令，或直接说你想做什么。"
            : "";
      return {
        kind: "text",
        text: formatFileOverview(name, kind, { bytes: buffer.byteLength }) + note,
      };
    }

    const stats = summarizeText(buffer);
    // Keep the tail of the text for a follow-up, within a bounded budget.
    pending.set(message.chatId, {
      name,
      text: buffer.toString("utf8").slice(0, PENDING_MAX_CHARS),
      at: Date.now(),
    });
    const hint = llm ? "\n\n可以接着问「分析一下」或「总结」。使用「重置」清除。" : "";
    return { kind: "text", text: formatFileOverview(name, kind, stats) + hint };
  }

  return async function handler(message: Incoming): Promise<Reply | null> {
    // Files are handled before the text path: a "file" message has no text, and
    // the overview is deterministic (no model call needed to count rows).
    if (message.msgType === "file") {
      return handleFile(message);
    }
    if (message.msgType !== "text") {
      return { kind: "text", text: `暂时只处理文本和文件消息（收到 ${message.msgType}）。` };
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

    // A follow-up about the last upload, if there is a fresh one.
    const held = pending.get(message.chatId);
    if (held && Date.now() - held.at > PENDING_TTL_MS) pending.delete(message.chatId);
    const fresh = pending.get(message.chatId);
    if (fresh && llm && ANALYSE.test(command)) {
      try {
        const answer = await llm.chat([
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `以下是用户上传的文件 ${fresh.name} 的内容，请按要求处理：${text}\n\n---\n${fresh.text}`,
          },
        ]);
        return { kind: "text", text: answer };
      } catch (error) {
        const detail = error instanceof LlmError ? error.message : "unexpected error";
        logger.error(`file analysis failed: ${redact(detail, secret)}`);
        return { kind: "text", text: "模型暂时不可用，稍后再试。" };
      }
    }

    // Sandbox dispatch. Placed before the model and before flows: a task
    // request must never be "answered" conversationally.
    const sandboxMatch = (options.sandboxTrigger ?? SANDBOX_COMMANDS).exec(text);
    if (sandboxMatch) {
      const task = (sandboxMatch[1] ?? "").trim();
      const sandbox = options.sandbox;
      if (!sandbox || !sandbox.configured) {
        return { kind: "text", text: "沙箱服务未启用。" };
      }
      if (!sandbox.isAllowed(message.openId)) {
        // Deny-by-default: say so plainly, and never run the task.
        logger.error(`sandbox denied open_id=${message.openId ?? "-"} chat=${message.chatId}`);
        return { kind: "text", text: "你没有沙箱执行权限。" };
      }
      if (!task) return { kind: "text", text: SANDBOX_HELP };
      try {
        const result = await sandbox.run({
          chatId: message.chatId,
          messageId: message.messageId,
          text: task,
          systemPrompt,
        });
        const header = result.status === "done" ? "完成" : `结束（${result.status}）`;
        return { kind: "text", text: `${header}\n\n${result.finalText}` };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown";
        logger.error(`sandbox failed chat=${message.chatId}: ${reason}`);
        return { kind: "text", text: `沙箱执行失败：${reason}` };
      }
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
