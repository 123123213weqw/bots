import assert from "node:assert/strict";
import { test } from "node:test";

import { History } from "../src/history.ts";

test("history starts empty and records an exchange", () => {
  const h = new History();
  assert.deepEqual(h.get("oc_1"), []);
  h.add("oc_1", "q1", "a1");
  assert.deepEqual(h.get("oc_1"), [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
  ]);
});

test("chats are isolated from each other", () => {
  const h = new History();
  h.add("oc_1", "q1", "a1");
  assert.deepEqual(h.get("oc_2"), []);
});

test("only the last N messages are kept", () => {
  const h = new History(10, 4);
  for (let i = 0; i < 5; i += 1) h.add("oc", `q${i}`, `a${i}`);
  const kept = h.get("oc");
  assert.equal(kept.length, 4, `kept=${kept.length}`);
  // The most recent exchange must survive, the oldest must be gone.
  assert.deepEqual(kept.at(-2), { role: "user", content: "q4" });
  assert.deepEqual(kept.at(-1), { role: "assistant", content: "a4" });
  assert.ok(!kept.some((m) => m.content === "q0"));
});

test("clear actually forgets the chat", () => {
  const h = new History();
  h.add("oc_1", "q", "a");
  h.clear("oc_1");
  assert.deepEqual(h.get("oc_1"), []);
});

test("the number of tracked chats is bounded", () => {
  const h = new History(3, 6);
  for (let i = 0; i < 10; i += 1) h.add(`oc_${i}`, "q", "a");
  assert.ok(h.size <= 3, `size=${h.size}`);
});
