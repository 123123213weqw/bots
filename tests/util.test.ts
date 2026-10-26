import assert from "node:assert/strict";
import { test } from "node:test";

import { Deduper, LruCache, Queue, chunk, stripMentions } from "../src/util.ts";

test("dedupe: first sighting wins", () => {
  const dedupe = new Deduper();
  assert.equal(dedupe.firstSight("om_1"), true);
  assert.equal(dedupe.firstSight("om_1"), false);
  assert.equal(dedupe.firstSight("om_2"), true);
});

test("dedupe: entries expire so memory stays bounded", () => {
  const dedupe = new Deduper(5_000);
  assert.equal(dedupe.firstSight("x", 1_000), true);
  assert.equal(dedupe.firstSight("x", 3_000), false);
  assert.equal(dedupe.firstSight("x", 7_000), true);
});

test("dedupe: hard cap clears instead of growing forever", () => {
  const dedupe = new Deduper(1_000_000, 3);
  for (let i = 0; i < 50; i += 1) dedupe.firstSight(`k${i}`, i);
  assert.ok(dedupe.size <= 3, `size=${dedupe.size}`);
});

test("mentions are stripped", () => {
  assert.equal(stripMentions("@_user_1 deploy now"), "deploy now");
  assert.equal(stripMentions("@_user_12 @_user_3  hi"), "hi");
  assert.equal(stripMentions("no mention"), "no mention");
});

test("@_all is stripped too, not just @_user_N", () => {
  assert.equal(stripMentions("@_all ship it"), "ship it");
  assert.equal(stripMentions("@_all @_user_1 hi"), "hi");
  // A lone mention leaves nothing, which is what the handler expects.
  assert.equal(stripMentions("@_all"), "");
});

test("chunk: keeps short text intact and splits long text", () => {
  assert.deepEqual(chunk("short"), ["short"]);
  assert.deepEqual(chunk("a".repeat(9000)).map((s) => s.length), [4000, 4000, 1000]);
});

test("chunk: never splits a surrogate pair", () => {
  const emoji = "😀"; // two code units
  const text = "a".repeat(3999) + emoji + "b";
  const parts = chunk(text, 4000);
  for (const part of parts) {
    assert.equal(part.isWellFormed(), true, "produced a lone surrogate");
  }
  assert.equal(parts.join(""), text);
});

test("queue: honours the concurrency limit and drains", async () => {
  const queue = new Queue(2);
  let running = 0;
  let peak = 0;
  const jobs = Array.from({ length: 6 }, () =>
    queue.run(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    }),
  );
  await Promise.all(jobs);
  assert.equal(peak, 2);
  await queue.whenIdle();
  assert.equal(queue.active, 0);
});

test("queue: whenIdle resolves after the last job", async () => {
  const queue = new Queue(1);
  let finished = false;
  void queue.run(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    finished = true;
  });
  await queue.whenIdle();
  assert.equal(finished, true);
});

test("lru: evicts the oldest entry", () => {
  const cache = new LruCache<number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1); // refresh
  cache.set("c", 3);
  assert.equal(cache.size, 2);
  assert.equal(cache.get("b"), undefined, "b should have been evicted");
  assert.equal(cache.get("a"), 1);
});
