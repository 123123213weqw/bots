import assert from "node:assert/strict";
import { test } from "node:test";

import { createHandler } from "../src/handler.ts";
import { Dialogue } from "../src/machine.ts";
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

// ---- dialogue integration ---------------------------------------------------

function goFlow() {
  const d = new Dialogue({
    initial: "idle",
    states: { idle: {}, asking: { prompt: "请发送名字。" } },
    cancel: /^(取消|cancel)$/i,
    onUnmatched: "请发送名字，或发「取消」。",
    transitions: [
      { from: "*", match: /^开始$/i, to: "asking" },
      {
        from: ["asking"],
        match: /^名字是(.+)$/,
        to: "idle",
        action: (ctx) => `记住了：${/^名字是(.+)$/.exec(ctx.text)![1]}`,
      },
    ],
  });
  return d;
}

test("a flow interruption is answered by the flow, not the model", async () => {
  const { llm, calls } = fakeLlm("模型回答");
  const dialogue = goFlow();
  const handler = createHandler({ llm, dialogue, logger: quiet });

  const first = await handler(incoming("开始"));
  assert.equal((first as { text: string }).text, "请发送名字。");
  assert.equal(calls.length, 0, "the trigger must not cost a model call");

  const second = await handler(incoming("名字是老王"));
  assert.match((second as { text: string }).text, /记住了：老王/);
  assert.equal(calls.length, 0, "slot answers must not cost a model call either");
});

test("after the flow closes, the model answers again", async () => {
  const { llm, calls } = fakeLlm("模型回答");
  const handler = createHandler({ llm, dialogue: goFlow(), logger: quiet });

  await handler(incoming("开始"));
  await handler(incoming("名字是老王"));
  const third = await handler(incoming("普通问题"));

  assert.deepEqual(third, { kind: "text", text: "模型回答" });
  assert.equal(calls.length, 1, "the chat must not stay captured");
});

test("the reset command also drops an active flow", async () => {
  const { llm, calls } = fakeLlm("模型回答");
  const dialogue = goFlow();
  const handler = createHandler({ llm, dialogue, logger: quiet });

  await handler(incoming("开始"));
  assert.ok(dialogue.peek("oc_1"), "flow should be active");

  await handler(incoming("重置"));
  assert.equal(dialogue.peek("oc_1"), undefined);

  const after = await handler(incoming("普通问题"));
  assert.deepEqual(after, { kind: "text", text: "模型回答" });
  assert.equal(calls.length, 1);
});

test("without a dialogue the handler behaves exactly as before", async () => {
  const { llm } = fakeLlm("模型回答");
  const handler = createHandler({ llm, logger: quiet });
  assert.deepEqual(await handler(incoming("开始")), { kind: "text", text: "模型回答" });
});

// ---- inbound files ----------------------------------------------------------

function fileIncoming(name: string, chatId = "oc_1"): Incoming {
  return {
    messageId: "om_file",
    chatId,
    chatType: "p2p",
    msgType: "file",
    text: "",
    fileKey: "file_v3_abc",
    fileName: name,
    openId: "ou_1",
    raw: {},
  };
}

test("a text file is summarised without calling the model", async () => {
  const { llm, calls } = fakeLlm("不该被用到");
  const csv = Buffer.from("name,age\nx,1\ny,2\n");
  const handler = createHandler({
    llm,
    logger: quiet,
    downloadFile: async () => csv,
  });

  const reply = await handler(fileIncoming("people.csv"));
  const text = (reply as { text: string }).text;

  assert.match(text, /people\.csv/);
  assert.match(text, /2 列（逗号分隔）/);
  assert.equal(calls.length, 0, "counting rows must not cost a model call");
});

test("the uploaded name is sanitised before it reaches the user", async () => {
  const handler = createHandler({
    llm: null,
    logger: quiet,
    downloadFile: async () => Buffer.from("x"),
  });
  const reply = await handler(fileIncoming("../../etc/secret.txt"));
  const text = (reply as { text: string }).text;

  assert.doesNotMatch(text, /\.\.\//);
  assert.match(text, /secret\.txt/);
});

test("an oversized file is rejected before decoding", async () => {
  const handler = createHandler({
    llm: null,
    logger: quiet,
    downloadFile: async () => Buffer.alloc(30 * 1024 * 1024 + 1),
  });
  const reply = await handler(fileIncoming("huge.bin"));
  assert.match((reply as { text: string }).text, /超过上限/);
});

test("an empty upload is refused with a reason", async () => {
  const handler = createHandler({
    llm: null,
    logger: quiet,
    downloadFile: async () => Buffer.alloc(0),
  });
  const reply = await handler(fileIncoming("empty.txt"));
  assert.match((reply as { text: string }).text, /空/);
});

test("a download failure is reported, not swallowed", async () => {
  const handler = createHandler({
    llm: null,
    logger: quiet,
    downloadFile: async () => {
      throw new Error("network down");
    },
  });
  const reply = await handler(fileIncoming("a.csv"));
  assert.match((reply as { text: string }).text, /无法处理/);
});

test("a binary disguised as .txt gets no text preview", async () => {
  const handler = createHandler({
    llm: null,
    logger: quiet,
    downloadFile: async () => Buffer.from([0x00, 0x01, 0x02, 0x03]),
  });
  const text = ((await handler(fileIncoming("payload.txt"))) as { text: string }).text;
  assert.match(text, /二进制/);
  assert.doesNotMatch(text, /字符/);
});

test("a follow-up 'analyse' uses the file that was just uploaded", async () => {
  const { llm, calls } = fakeLlm("这是摘要");
  const handler = createHandler({
    llm,
    logger: quiet,
    downloadFile: async () => Buffer.from("第一行\n第二行\n"),
  });

  await handler(fileIncoming("notes.md"));
  const reply = await handler(incoming("分析一下"));

  assert.deepEqual(reply, { kind: "text", text: "这是摘要" });
  assert.equal(calls.length, 1);
  const sent = calls[0]!.map((m) => m.content).join("\n");
  assert.match(sent, /notes\.md/, "the model must be told which file this is");
  assert.match(sent, /第一行/, "the file content must be included");
});

test("'analyse' with no upload falls through to normal chat", async () => {
  const { llm, calls } = fakeLlm("普通回答");
  const handler = createHandler({ llm, logger: quiet });
  const reply = await handler(incoming("分析一下"));
  assert.deepEqual(reply, { kind: "text", text: "普通回答" });
  assert.equal(calls.length, 1);
});

test("uploads are tracked per chat, not globally", async () => {
  const { llm, calls } = fakeLlm("答");
  const handler = createHandler({
    llm,
    logger: quiet,
    downloadFile: async () => Buffer.from("secret-from-chat-A\n"),
  });

  await handler(fileIncoming("a.txt", "oc_A"));
  await handler(incoming("分析一下", "text", "oc_B"));

  const sent = calls[0]!.map((m) => m.content).join("\n");
  assert.doesNotMatch(sent, /secret-from-chat-A/, "another chat's file must not leak");
});

test("CJK analysis verbs work without a word boundary", async () => {
  // `\b` needs a \w neighbour and CJK is not \w, so /分析\b/ never matches
  // "分析一下". This pins the fix.
  const { llm } = fakeLlm("答");
  const handler = createHandler({
    llm,
    logger: quiet,
    downloadFile: async () => Buffer.from("x\n"),
  });
  await handler(fileIncoming("a.txt"));
  for (const phrase of ["分析一下", "总结", "解释", "摘要", "解读"]) {
    const r = await handler(incoming(phrase));
    assert.deepEqual(r, { kind: "text", text: "答" }, `${phrase} should be recognised`);
  }
});

test("a word starting with 分 is not treated as an analysis request", async () => {
  const { llm, calls } = fakeLlm("普通回答");
  const handler = createHandler({
    llm,
    logger: quiet,
    downloadFile: async () => Buffer.from("x\n"),
  });
  await handler(fileIncoming("a.txt"));
  await handler(incoming("分别看一下这两个方案"));
  // It reached the model as *chat*, not as a file instruction.
  const sent = calls[0]!.map((m) => m.content).join("\n");
  assert.doesNotMatch(sent, /以下是用户上传的文件/, "should not be a file request");
});

// ---- sandbox dispatch -------------------------------------------------------

function fakeSandbox(allowed: boolean) {
  const runs: Array<{ chatId: string; messageId: string; text: string }> = [];
  return {
    runs,
    sandbox: {
      configured: true,
      allowlistSize: allowed ? 1 : 0,
      isAllowed: () => allowed,
      health: async () => true,
      run: async (opts: { chatId: string; messageId: string; text: string }) => {
        runs.push(opts);
        return { status: "done", finalText: "执行结果" };
      },
    },
  };
}

test("an allowed user's plain message goes straight to the host", async () => {
  const { sandbox, runs } = fakeSandbox(true);
  const { llm, calls } = fakeLlm("不应被调用");
  const handler = createHandler({ llm, sandbox: sandbox as never, logger: quiet });

  // 不再需要 `沙箱` 前缀：host 是主脑。
  const reply = await handler(incoming("数一下有多少个文件"));
  assert.match((reply as { text: string }).text, /执行结果/);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.text, "数一下有多少个文件");
  assert.equal(calls.length, 0, "有 host 时不应再走 TS 的模型对话");
});

test("the 沙箱 prefix is still accepted but redundant", async () => {
  const { sandbox, runs } = fakeSandbox(true);
  const handler = createHandler({ llm: null, sandbox: sandbox as never, logger: quiet });
  await handler(incoming("沙箱 数文件"));
  assert.equal(runs[0]?.text, "数文件", "前缀应被剥掉");
});

test("an unauthorised user's explicit task is refused and nothing runs", async () => {
  const { sandbox, runs } = fakeSandbox(false);
  const { llm } = fakeLlm("降级回答");
  const handler = createHandler({ llm, sandbox: sandbox as never, logger: quiet });

  const reply = await handler(incoming("沙箱 rm -rf /"));
  assert.match((reply as { text: string }).text, /没有执行权限/);
  assert.equal(runs.length, 0, "未授权时绝不能执行");
});

test("an unauthorised user's plain message falls back to chat, no tools", async () => {
  const { sandbox, runs } = fakeSandbox(false);
  const { llm } = fakeLlm("我是普通回答");
  const handler = createHandler({ llm, sandbox: sandbox as never, logger: quiet });

  const reply = await handler(incoming("今天天气怎么样"));
  assert.deepEqual(reply, { kind: "text", text: "我是普通回答" });
  assert.equal(runs.length, 0, "降级对话不得触达 host");
});

test("without a host the bot still chats", async () => {
  const { llm } = fakeLlm("模型回答");
  const handler = createHandler({ llm, sandbox: null, logger: quiet });
  const reply = await handler(incoming("随便聊聊"));
  assert.deepEqual(reply, { kind: "text", text: "模型回答" });
});

test("a host failure is reported, not swallowed", async () => {
  const failing = {
    configured: true,
    allowlistSize: 1,
    isAllowed: () => true,
    reset: () => {},
    health: async () => true,
    run: async () => {
      throw new Error("host task timed out after 300s");
    },
  };
  const handler = createHandler({ llm: null, sandbox: failing as never, logger: quiet });
  const reply = await handler(incoming("长任务"));
  assert.match((reply as { text: string }).text, /执行失败/);
  assert.match((reply as { text: string }).text, /timed out/);
});

test("fast commands stay local so they cost no latency", async () => {
  const { sandbox, runs } = fakeSandbox(true);
  const handler = createHandler({ llm: null, sandbox: sandbox as never, logger: quiet });
  assert.deepEqual(await handler(incoming("ping")), { kind: "text", text: "pong" });
  assert.equal(runs.length, 0, "ping 不该付 1 秒的 host 延迟");
});

test("reset clears the host session too, not just local history", async () => {
  let resets = 0;
  const sandbox = {
    configured: true,
    allowlistSize: 1,
    isAllowed: () => true,
    health: async () => true,
    reset: () => {
      resets += 1;
    },
    run: async () => ({ status: "done", finalText: "ok" }),
  };
  const handler = createHandler({ llm: null, sandbox: sandbox as never, logger: quiet });
  await handler(incoming("重置"));
  assert.equal(resets, 1, "不清 host 会话的话，'清空'就是假动作");
});

test("the caller's role instructions are forwarded, not dropped", async () => {
  const captured: Array<{ systemPrompt?: string }> = [];
  const sandbox = {
    configured: true,
    allowlistSize: 1,
    isAllowed: () => true,
    reset: () => {},
    health: async () => true,
    run: async (o: { systemPrompt?: string }) => {
      captured.push(o);
      return { status: "done", finalText: "ok" };
    },
  };
  const handler = createHandler({ llm: null, sandbox: sandbox as never, logger: quiet });
  await handler(incoming("做点什么"));
  // 之前角色设定被拼进 user message；现在必须作为 systemPrompt 单独下发，
  // 否则 Rust 侧会退回默认、且 systemTokens 为 0。
  assert.ok(captured[0]?.systemPrompt, "systemPrompt 不应为空");
  assert.match(captured[0]!.systemPrompt!, /飞书/);
});
