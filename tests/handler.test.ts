import assert from "node:assert/strict";
import { test } from "node:test";

import { createHandler } from "../src/handler.ts";
import { History } from "../src/history.ts";
import { LlmError } from "../src/llm.ts";
import type { ChatMessage, Llm } from "../src/llm.ts";
import type { Incoming } from "../src/bot.ts";

const SECRET = "sk-test-0123456789abcdef0123456789";

function incoming(text: string, msgType = "text", chatId = "oc_1"): Incoming {
  return {
    messageId: "om_1",
    chatId,
    chatType: "group",
    msgType,
    text,
    openId: "ou_1",
    raw: {},
  };
}

function fakeLlm(reply: string | Error) {
  const calls: ChatMessage[][] = [];
  const llm: Llm = {
    async chat(messages) {
      calls.push(messages);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { llm, calls };
}

const quiet = { info: () => {}, error: () => {} };

test("no model configured: echo mode still answers", async () => {
  const handler = createHandler({ llm: null, logger: quiet });
  const reply = await handler(incoming("你好"));
  assert.equal(reply?.kind, "text");
  assert.match((reply as { text: string }).text, /你好/);
  assert.match((reply as { text: string }).text, /回显模式/);
});

test("ping is answered without a model call", async () => {
  const { llm, calls } = fakeLlm("should not be used");
  const handler = createHandler({ llm, logger: quiet });
  const reply = await handler(incoming("PING"));
  assert.deepEqual(reply, { kind: "text", text: "pong" });
  assert.equal(calls.length, 0);
});

test("image command returns an image reply when a path is configured", async () => {
  const handler = createHandler({ llm: null, imagePath: "/tmp/x.png", logger: quiet });
  const reply = await handler(incoming("图"));
  assert.equal(reply?.kind, "image");
});

test("non-text messages are declined politely", async () => {
  const handler = createHandler({ llm: null, logger: quiet });
  const reply = await handler(incoming("", "image"));
  assert.match((reply as { text: string }).text, /image/);
});

test("empty text asks for input", async () => {
  const handler = createHandler({ llm: null, logger: quiet });
  assert.deepEqual(await handler(incoming("")), { kind: "text", text: "在，说点什么？" });
});

test("model answer is returned and remembered", async () => {
  const { llm, calls } = fakeLlm("这是回答");
  const history = new History();
  const handler = createHandler({ llm, history, logger: quiet });

  const reply = await handler(incoming("问题一"));
  assert.deepEqual(reply, { kind: "text", text: "这是回答" });

  // system prompt first, then the user turn
  assert.equal(calls[0]?.[0]?.role, "system");
  assert.deepEqual(calls[0]?.at(-1), { role: "user", content: "问题一" });

  await handler(incoming("问题二"));
  // the second call must include the first exchange
  const second = calls[1] ?? [];
  assert.ok(
    second.some((m) => m.content === "问题一") &&
      second.some((m) => m.content === "这是回答"),
    "history was not included in the follow-up call",
  );
});

test("reset clears context so the next call starts clean", async () => {
  const { llm, calls } = fakeLlm("a");
  const history = new History();
  const handler = createHandler({ llm, history, logger: quiet });

  await handler(incoming("记住我"));
  assert.equal(history.get("oc_1").length, 2);

  const reset = await handler(incoming("重置"));
  assert.match((reset as { text: string }).text, /清空/);
  assert.equal(history.get("oc_1").length, 0);

  await handler(incoming("新话题"));
  const last = calls.at(-1) ?? [];
  assert.equal(last.length, 2, "reset did not prevent history from being sent");
  assert.equal(last[1]?.content, "新话题");
});

test("a model failure yields a generic reply and never leaks the key", async () => {
  const leaky = new LlmError(`http 401: invalid key ${SECRET}`, 401);
  const logged: string[] = [];
  const handler = createHandler({
    llm: fakeLlm(leaky).llm,
    logger: { info: () => {}, error: (m: string) => logged.push(m) },
    secret: SECRET,
  });

  const reply = await handler(incoming("hi"));
  assert.deepEqual(reply, { kind: "text", text: "模型暂时不可用，稍后再试。" });

  assert.equal(logged.length, 1);
  assert.ok(!logged[0]?.includes(SECRET), "secret leaked into the log");
  assert.match(logged[0] ?? "", /redacted/);
});

test("chats keep separate histories", async () => {
  const { llm, calls } = fakeLlm("a");
  const handler = createHandler({ llm, logger: quiet });

  await handler(incoming("hello", "text", "oc_A"));
  await handler(incoming("hello", "text", "oc_B"));
  // neither call should contain the other chat's turn
  assert.equal(calls[1]?.length, 2, "history leaked across chats");
});
