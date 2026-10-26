/** Event → handler → reply. The handler must never block the event loop. */
import { stripMentions, Deduper, Queue } from "./util.ts";
import type { MediaSource, Messenger } from "./feishu.ts";

export type Reply =
  | { kind: "text"; text: string }
  | { kind: "image"; source: MediaSource; caption?: string };

export interface Incoming {
  messageId: string;
  chatId: string;
  chatType: string;
  msgType: string;
  /** Text with @-mention placeholders removed; empty for non-text messages. */
  text: string;
  openId?: string;
  raw: unknown;
}

export type Handler = (message: Incoming) => Promise<Reply | null> | Reply | null;

export interface BotOptions {
  /** Reply in-thread to the triggering message (default) or post a new message. */
  mode?: "reply" | "send";
  concurrency?: number;
  logger?: Pick<Console, "info" | "error" | "warn">;
}

export interface RawEvent {
  sender?: { sender_id?: { open_id?: string } };
  message: {
    message_id: string;
    chat_id: string;
    chat_type?: string;
    message_type: string;
    content: string;
  };
}

export function toIncoming(event: RawEvent): Incoming {
  const message = event.message;
  let text = "";
  if (message.message_type === "text") {
    try {
      text = stripMentions(String(JSON.parse(message.content).text ?? ""));
    } catch {
      text = "";
    }
  }
  return {
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type ?? "",
    msgType: message.message_type,
    text,
    openId: event.sender?.sender_id?.open_id,
    raw: message,
  };
}

export class Bot {
  #messenger: Messenger;
  #handler: Handler;
  #dedupe = new Deduper();
  #queue: Queue;
  #mode: "reply" | "send";
  #log: Pick<Console, "info" | "error" | "warn">;

  constructor(messenger: Messenger, handler: Handler, options: BotOptions = {}) {
    this.#messenger = messenger;
    this.#handler = handler;
    this.#queue = new Queue(options.concurrency ?? 8);
    this.#mode = options.mode ?? "reply";
    this.#log = options.logger ?? console;
  }

  /** Called by the SDK dispatcher. Returns immediately: it only enqueues. */
  onEvent = (event: RawEvent): void => {
    const message = event.message;
    if (!this.#dedupe.firstSight(message.message_id)) {
      this.#log.info(`duplicate ignored id=${message.message_id}`);
      return;
    }
    void this.#queue.run(() => this.#process(event)).catch((error: unknown) => {
      this.#log.error(`handler failed id=${message.message_id} ${String(error)}`);
    });
  };

  whenIdle(): Promise<void> {
    return this.#queue.whenIdle();
  }

  async #process(event: RawEvent): Promise<void> {
    const incoming = toIncoming(event);
    this.#log.info(
      `recv chat=${incoming.chatId} type=${incoming.msgType} text=${JSON.stringify(incoming.text.slice(0, 120))}`,
    );
    const reply = await this.#handler(incoming);
    if (!reply) return;
    await this.#deliver(incoming, reply);
  }

  async #deliver(incoming: Incoming, reply: Reply): Promise<void> {
    const toThread = this.#mode === "reply";
    if (reply.kind === "text") {
      if (toThread) {
        await this.#messenger.replyText(incoming.messageId, reply.text, incoming.messageId);
      } else {
        await this.#messenger.sendText(incoming.chatId, reply.text, incoming.messageId);
      }
      return;
    }
    if (reply.caption) {
      if (toThread) await this.#messenger.replyText(incoming.messageId, reply.caption);
      else await this.#messenger.sendText(incoming.chatId, reply.caption);
    }
    if (toThread) {
      await this.#messenger.replyImage(incoming.messageId, reply.source);
    } else {
      await this.#messenger.sendImage(incoming.chatId, reply.source);
    }
  }
}
