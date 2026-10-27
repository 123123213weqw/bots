import assert from "node:assert/strict";
import { test } from "node:test";

import { Dialogue } from "../src/machine.ts";
import type { MachineDef } from "../src/machine.ts";
import { RepoQueryError, formatRepo, repoLookupFlow } from "../src/flows.ts";
import type { RepoInfo } from "../src/flows.ts";

const clock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
};

/** Three states: idle --go--> asking --value--> done, with a capture + action. */
function demo(): MachineDef {
  return {
    initial: "idle",
    defaultTtlMs: 60_000,
    cancel: /^(取消|cancel)$/i,
    onUnmatched: "请发送一个值。",
    states: {
      idle: {},
      asking: { prompt: "请发送一个值。" },
      done: {},
    },
    transitions: [
      { from: "*", match: /^go$/i, to: "asking" },
      {
        from: ["asking"],
        match: /^v:(\w+)$/,
        to: "done",
        capture: { key: "value", group: 1 },
        action: (ctx) => `got:${ctx.data["value"]}`,
      },
    ],
  };
}

test("a message that matches nothing in idle is not handled", async () => {
  const d = new Dialogue(demo());
  const r = await d.step("c1", "hello there");
  assert.equal(r.handled, false);
  assert.equal(r.state, "idle");
});

test("trigger moves into the flow and emits the prompt", async () => {
  const d = new Dialogue(demo());
  const r = await d.step("c1", "go");
  assert.equal(r.handled, true);
  assert.equal(r.state, "asking");
  assert.equal(r.reply, "请发送一个值。");
  assert.equal(d.peek("c1")?.state, "asking");
});

test("capture, action and return to idle", async () => {
  const d = new Dialogue(demo());
  await d.step("c1", "go");
  const r = await d.step("c1", "v:abc");
  assert.equal(r.reply, "got:abc");
  assert.equal(r.state, "done");
  // `done` is not initial, so a session exists until it maps back to idle
  assert.equal(d.peek("c1")?.state, "done");
});

test("unmatched input inside a flow hints instead of reaching the model", async () => {
  const d = new Dialogue(demo());
  await d.step("c1", "go");
  const r = await d.step("c1", "!!! not a value !!!");
  assert.equal(r.handled, true, "must be consumed, or the model answers out of context");
  assert.equal(r.reply, "请发送一个值。");
  assert.equal(d.peek("c1")?.state, "asking", "flow must stay put");
});

test("cancel aborts from inside the flow", async () => {
  const d = new Dialogue(demo());
  await d.step("c1", "go");
  const r = await d.step("c1", "取消");
  assert.equal(r.handled, true);
  assert.equal(r.state, "idle");
  assert.equal(r.reset, true);
  assert.equal(d.peek("c1"), undefined);
});

test("cancel in idle is not special-cased", async () => {
  const d = new Dialogue(demo());
  const r = await d.step("c1", "取消");
  assert.equal(r.handled, false, "idle cancel should fall through to normal handling");
});

test("an abandoned flow expires and stops capturing the chat", async () => {
  const c = clock();
  const d = new Dialogue(demo(), { now: c.now });
  await d.step("c1", "go", c.now());

  c.advance(61_000); // past the TTL
  const r = await d.step("c1", "随便说点什么", c.now());

  assert.equal(r.handled, false, "expired flow must not answer");
  assert.equal(r.reset, true);
  assert.equal(d.peek("c1"), undefined);
});

test("a fresh trigger works immediately after expiry", async () => {
  const c = clock();
  const d = new Dialogue(demo(), { now: c.now });
  await d.step("c1", "go", c.now());
  c.advance(61_000);
  const r = await d.step("c1", "go", c.now());
  assert.equal(r.handled, true);
  assert.equal(r.state, "asking");
});

test("re-entering a state refreshes its TTL", async () => {
  const c = clock();
  const d = new Dialogue(demo(), { now: c.now });
  await d.step("c1", "go", c.now());
  c.advance(50_000);
  await d.step("c1", "junk", c.now()); // consumed, TTL refreshed
  c.advance(50_000); // 100s after entry, but 50s after refresh
  const r = await d.step("c1", "v:abc", c.now());
  assert.equal(r.reply, "got:abc", "flow should still be alive");
});

test("chats are isolated", async () => {
  const d = new Dialogue(demo());
  await d.step("c1", "go");
  const r = await d.step("c2", "hello");
  assert.equal(r.handled, false, "another chat must not inherit the flow");
});

test("clear() drops a flow (used by the reset command)", async () => {
  const d = new Dialogue(demo());
  await d.step("c1", "go");
  d.clear("c1");
  assert.equal(d.peek("c1"), undefined);
  const r = await d.step("c1", "v:abc");
  assert.equal(r.handled, false);
});

test("the number of tracked chats is bounded", async () => {
  const d = new Dialogue(demo(), { chats: 3 });
  for (let i = 0; i < 20; i += 1) await d.step(`c${i}`, "go");
  assert.ok(d.size <= 3, `size=${d.size}`);
});

test("a predicate matcher and a static reply work", async () => {
  const d = new Dialogue({
    initial: "idle",
    states: { idle: {}, yes: {} },
    transitions: [
      { from: "*", match: (ctx) => ctx.text === "来", to: "yes", reply: "好" },
    ],
  });
  const r = await d.step("c1", "来");
  assert.equal(r.reply, "好");
  assert.equal(r.state, "yes");
});

test("no reply configured and no prompt yields handled with no text", async () => {
  const d = new Dialogue({
    initial: "idle",
    states: { idle: {}, silent: {} },
    transitions: [{ from: "*", match: /^silent$/i, to: "silent" }],
  });
  const r = await d.step("c1", "silent");
  assert.equal(r.handled, true);
  assert.equal(r.reply, undefined);
});

// ---- the real flow, with a fake fetcher -------------------------------------

function fakeFetcher(result: RepoInfo | null) {
  const calls: string[] = [];
  return {
    calls,
    fetcher: {
      async fetch(fullName: string) {
        calls.push(fullName);
        return result;
      },
    },
  };
}

const VLLM: RepoInfo = {
  fullName: "vllm-project/vllm",
  stars: 95600,
  language: "Python",
  license: "Apache-2.0",
  description: "A high-throughput and memory-efficient inference and serving engine",
  pushedAt: "2026-10-26T00:00:00Z",
  url: "https://github.com/vllm-project/vllm",
};

test("repo flow: trigger then a valid name returns real metadata", async () => {
  const { fetcher, calls } = fakeFetcher(VLLM);
  const d = new Dialogue(repoLookupFlow(fetcher));

  const first = await d.step("c1", "查仓库");
  assert.equal(first.state, "await_repo");
  assert.match(first.reply ?? "", /owner\/repo/);

  const second = await d.step("c1", "vllm-project/vllm");
  assert.deepEqual(calls, ["vllm-project/vllm"]);
  assert.match(second.reply ?? "", /vllm-project\/vllm/);
  assert.match(second.reply ?? "", /95600★/);
  assert.match(second.reply ?? "", /Apache-2\.0/);
  assert.equal(second.state, "idle");
});

test("repo flow: a bare word does not count as a repository name", async () => {
  const { fetcher, calls } = fakeFetcher(VLLM);
  const d = new Dialogue(repoLookupFlow(fetcher));
  await d.step("c1", "查仓库");
  const r = await d.step("c1", "vllm");
  assert.equal(r.handled, true);
  assert.match(r.reply ?? "", /owner\/repo/, "should re-ask");
  assert.deepEqual(calls, [], "must not call the API for a malformed name");
});

test("repo flow: a missing repo is reported, not thrown", async () => {
  const { fetcher } = fakeFetcher(null);
  const d = new Dialogue(repoLookupFlow(fetcher));
  await d.step("c1", "查仓库");
  const r = await d.step("c1", "nobody/nothing-here");
  assert.match(r.reply ?? "", /没找到/);
  assert.equal(r.state, "idle");
});

test("repo flow: cancel works mid-flow", async () => {
  const { fetcher, calls } = fakeFetcher(VLLM);
  const d = new Dialogue(repoLookupFlow(fetcher));
  await d.step("c1", "查仓库");
  const r = await d.step("c1", "取消");
  assert.equal(r.state, "idle");
  assert.deepEqual(calls, []);
});

test("formatRepo states an unclear license instead of hiding it", () => {
  const text = formatRepo({ ...VLLM, license: "NOASSERTION" });
  assert.match(text, /license 不明确/);
});

test("repo flow: a network failure is not reported as 'not found'", async () => {
  const failing = {
    async fetch(): Promise<RepoInfo | null> {
      throw new RepoQueryError("network: cannot resolve host");
    },
  };
  const d = new Dialogue(repoLookupFlow(failing));
  await d.step("c1", "查仓库");
  const r = await d.step("c1", "vllm-project/vllm");

  // Saying "没找到" here would be a false claim about the repository.
  assert.doesNotMatch(r.reply ?? "", /没找到/);
  assert.match(r.reply ?? "", /网络/);
  assert.equal(r.state, "idle", "the flow must close so the chat is free");
});
