import assert from "node:assert/strict";
import { test } from "node:test";

import { Bot, toIncoming } from "../src/bot.ts";
import type { Incoming, Reply } from "../src/bot.ts";
import type { MediaSource } from "../src/feishu.ts";

interface Sent {
  kind: "text" | "image";
  target: "chat" | "reply";
  to: string;
  body: string;
}

function fakeMessenger() {
  const sent: Sent[] = [];
  const messenger = {
    async sendText(to: string, text: string) {
      sent.push({ kind: "text", target: "chat", to, body: text });
      return ["om_sent"];
    },
    async replyText(to: string, text: string) {
      sent.push({ kind: "text", target: "reply", to, body: text });
      return ["om_replied"];
    },
    async sendImage(to: string, _source: MediaSource) {
      sent.push({ kind: "image", target: "chat", to, body: "" });
      return "om_sent";
    },
    async replyImage(to: string, _source: MediaSource) {
      sent.push({ kind: "image", target: "reply", to, body: "" });
      return "om_replied";
    },
    async uploadImage() {
      return "img_key";
    },
    async downloadMessageImage() {
      return Buffer.alloc(0);
    },
    async downloadMessageFile() {
      return Buffer.alloc(0);
    },
  };
  return { messenger, sent };
}

function event(id: string, text = "hello", type = "text") {
  return {
    sender: { sender_id: { open_id: "ou_1" } },
    message: {
      message_id: id,
      chat_id: "oc_1",
      chat_type: "group",
      message_type: type,
      content: JSON.stringify({ text }),
    },
  };
}

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

test("toIncoming: parses text and strips the mention placeholder", () => {
  const incoming = toIncoming(event("om_1", "@_user_1 ping"));
  assert.equal(incoming.text, "ping");
  assert.equal(incoming.chatId, "oc_1");
  assert.equal(incoming.openId, "ou_1");
});

test("toIncoming: non-text content yields empty text, never throws", () => {
  assert.equal(toIncoming(event("om_2", "", "image")).text, "");
  const broken = {
    message: { message_id: "om_3", chat_id: "oc", message_type: "text", content: "not json" },
  };
  assert.equal(toIncoming(broken).text, "");
});

test("retries from the platform produce exactly one reply", async () => {
  const { messenger, sent } = fakeMessenger();
  const bot = new Bot(messenger, (m: Incoming): Reply => ({ kind: "text", text: `ok:${m.text}` }), {
    logger: quiet,
  });

  const payload = event("om_same", "@_user_1 hello");
  for (let i = 0; i < 5; i += 1) bot.onEvent(payload); // initial + 4 retries
  await bot.whenIdle();

  assert.deepEqual(sent, [
    { kind: "text", target: "reply", to: "om_same", body: "ok:hello" },
  ]);
});

test("distinct messages are both answered", async () => {
  const { messenger, sent } = fakeMessenger();
  const bot = new Bot(messenger, () => ({ kind: "text", text: "hi" }), { logger: quiet });
  bot.onEvent(event("om_a"));
  bot.onEvent(event("om_b"));
  await bot.whenIdle();
  assert.equal(sent.length, 2);
});

test("mode=send posts to the chat instead of replying in thread", async () => {
  const { messenger, sent } = fakeMessenger();
  const bot = new Bot(messenger, () => ({ kind: "text", text: "hi" }), {
    mode: "send",
    logger: quiet,
  });
  bot.onEvent(event("om_x"));
  await bot.whenIdle();
  assert.deepEqual(sent, [{ kind: "text", target: "chat", to: "oc_1", body: "hi" }]);
});

test("null reply stays silent", async () => {
  const { messenger, sent } = fakeMessenger();
  const bot = new Bot(messenger, () => null, { logger: quiet });
  bot.onEvent(event("om_silent"));
  await bot.whenIdle();
  assert.equal(sent.length, 0);
});

test("image reply goes through the image path", async () => {
  const { messenger, sent } = fakeMessenger();
  const bot = new Bot(
    messenger,
    () => ({ kind: "image", source: Buffer.from("png"), caption: "cap" }),
    { logger: quiet },
  );
  bot.onEvent(event("om_img"));
  await bot.whenIdle();
  assert.deepEqual(sent, [
    { kind: "text", target: "reply", to: "om_img", body: "cap" },
    { kind: "image", target: "reply", to: "om_img", body: "" },
  ]);
});

test("a throwing handler is contained and does not poison the queue", async () => {
  const { messenger, sent } = fakeMessenger();
  let calls = 0;
  const bot = new Bot(
    messenger,
    () => {
      calls += 1;
      if (calls === 1) throw new Error("handler exploded");
      return { kind: "text", text: "still alive" };
    },
    { logger: quiet },
  );

  bot.onEvent(event("om_boom"));
  bot.onEvent(event("om_ok"));
  await bot.whenIdle();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(sent, [
    { kind: "text", target: "reply", to: "om_ok", body: "still alive" },
  ]);
});

test("async handler is awaited before delivery", async () => {
  const { messenger, sent } = fakeMessenger();
  const bot = new Bot(
    messenger,
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { kind: "text", text: "late" };
    },
    { logger: quiet },
  );
  bot.onEvent(event("om_slow"));
  await bot.whenIdle();
  assert.equal(sent.length, 1);
});

test("onEvent returns synchronously (the 3 second budget)", () => {
  const { messenger } = fakeMessenger();
  const bot = new Bot(
    messenger,
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return null;
    },
    { logger: quiet },
  );
  const started = Date.now();
  bot.onEvent(event("om_fast"));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 50, `onEvent blocked for ${elapsed}ms`);
});
