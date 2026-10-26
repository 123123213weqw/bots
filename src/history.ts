/**
 * Conversation memory: short, bounded, per chat.
 *
 * The bot is stateless between restarts on purpose — a bot that remembers a
 * month of group chatter becomes both a privacy problem and an unbounded memory
 * leak. This keeps the last few turns so a follow-up question works, and nothing
 * else.
 */
import { LruCache } from "./util.ts";
import type { ChatMessage } from "./llm.ts";

export class History {
  #chats: LruCache<ChatMessage[]>;
  #perChat: number;

  constructor(chats = 200, perChat = 6) {
    this.#chats = new LruCache<ChatMessage[]>(chats);
    this.#perChat = perChat;
  }

  /** Messages to send for this chat, oldest first (excludes the new one). */
  get(chatId: string): ChatMessage[] {
    return this.#chats.get(chatId) ?? [];
  }

  /** Record one exchange, keeping only the last `perChat` messages. */
  add(chatId: string, user: string, assistant: string): void {
    const turns = this.#chats.get(chatId) ?? [];
    turns.push({ role: "user", content: user }, { role: "assistant", content: assistant });
    // Trim from the front so the most recent exchange always survives.
    this.#chats.set(chatId, turns.slice(-this.#perChat));
  }

  /** Forget one chat's context (the "reset" command). */
  clear(chatId: string): void {
    this.#chats.delete(chatId);
  }

  get size(): number {
    return this.#chats.size;
  }
}
