import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dedupe,
  formatDigest,
  isRelevant,
  selectRepos,
  starsPerDay,
} from "../src/digest.ts";
import type { Repo } from "../src/digest.ts";

const NOW = Date.parse("2026-10-26T00:00:00Z");

function repo(over: Partial<Repo> = {}): Repo {
  return {
    full_name: "acme/inference-engine",
    html_url: "https://github.com/acme/inference-engine",
    description: "A fast LLM inference engine with KV-cache",
    stargazers_count: 1000,
    language: "Python",
    license: "Apache-2.0",
    created_at: "2026-09-26T00:00:00Z", // 30 days before NOW
    pushed_at: "2026-10-20T00:00:00Z",
    archived: false,
    ...over,
  };
}

test("relevance keeps inference infra", () => {
  assert.equal(isRelevant(repo()), true);
  assert.equal(isRelevant(repo({ full_name: "x/vllm-fork" })), true);
  assert.equal(isRelevant(repo({ description: "GPU kernel for attention" })), true);
});

test("relevance rejects noise that topic search drags in", () => {
  // This really did appear under topic:llm-inference.
  assert.equal(
    isRelevant(repo({ full_name: "gitleaks/gitleaks", description: "Find secrets with Gitleaks" })),
    false,
  );
  assert.equal(
    isRelevant(repo({ full_name: "someone/todo", description: "A todo app" })),
    false,
  );
});

test("adjacent work is rejected: fine-tuning is not inference serving", () => {
  // This really did show up in the ecosystem section before the filter existed.
  assert.equal(
    isRelevant(
      repo({
        full_name: "hiyouga/LlamaFactory",
        description: "Unified Efficient Fine-Tuning of 100+ LLMs & VLMs (ACL 2024)",
      }),
    ),
    false,
  );
  assert.equal(
    isRelevant(repo({ full_name: "x/awesome-llm", description: "A curated list of LLM inference" })),
    false,
  );
});

test("serving engines and kernels are accepted", () => {
  assert.equal(
    isRelevant(
      repo({
        full_name: "vllm-project/vllm",
        description: "A high-throughput and memory-efficient inference and serving engine for LLMs",
      }),
    ),
    true,
  );
  assert.equal(
    isRelevant(repo({ full_name: "x/paged", description: "Paged attention CUDA kernels" })),
    true,
  );
});

test("the repo name alone can carry the signal", () => {
  // A name like this is meaningful even when the description is thin.
  assert.equal(
    isRelevant(repo({ full_name: "acme/vllm-server", description: "Server" })),
    true,
  );
});

test("relevance rejects archived and description-less repos", () => {
  assert.equal(isRelevant(repo({ archived: true })), false);
  assert.equal(isRelevant(repo({ description: null })), false);
});

test("stars per day is computed from creation date", () => {
  const r = repo({ stargazers_count: 3000, created_at: "2026-09-26T00:00:00Z" });
  const rate = starsPerDay(r, NOW);
  assert.ok(Math.abs(rate - 100) < 1, `expected ~100/day, got ${rate}`);
});

test("stars per day never divides by zero", () => {
  const r = repo({ created_at: "2026-10-26T00:00:00Z", stargazers_count: 5 });
  assert.ok(Number.isFinite(starsPerDay(r, NOW)));
  assert.ok(starsPerDay(r, NOW) > 0);
});

test("dedupe drops seen and repeated names, keeping order", () => {
  const a = repo({ full_name: "a/one" });
  const b = repo({ full_name: "b/two" });
  const out = dedupe([a, b, a], new Set(["b/two"]));
  assert.deepEqual(out.map((r) => r.full_name), ["a/one"]);
});

test("selection takes 3 fresh and 2 ecosystem without overlap", () => {
  const fresh = Array.from({ length: 5 }, (_, i) => repo({ full_name: `fresh/${i}` }));
  const eco = Array.from({ length: 5 }, (_, i) => repo({ full_name: `eco/${i}` }));
  const sel = selectRepos({ fresh, ecosystem: eco }, new Set());

  assert.equal(sel.fresh.length, 3);
  assert.equal(sel.ecosystem.length, 2);
  const all = [...sel.fresh, ...sel.ecosystem].map((r) => r.full_name);
  assert.equal(new Set(all).size, 5, "a repo was selected twice");
});

test("selection respects the seen list", () => {
  const fresh = [repo({ full_name: "fresh/a" }), repo({ full_name: "fresh/b" })];
  const sel = selectRepos({ fresh, ecosystem: [] }, new Set(["fresh/a"]));
  assert.deepEqual(sel.fresh.map((r) => r.full_name), ["fresh/b"]);
});

test("selection backfills from the other pool when one is exhausted", () => {
  const fresh = [repo({ full_name: "fresh/only" })];
  const eco = Array.from({ length: 6 }, (_, i) => repo({ full_name: `eco/${i}` }));
  const sel = selectRepos({ fresh, ecosystem: eco }, new Set());
  const total = sel.fresh.length + sel.ecosystem.length;
  assert.equal(total, 5, `expected 5 entries, got ${total}`);
});

test("digest text is plain and carries the original description", () => {
  const sel = selectRepos(
    { fresh: [repo({ full_name: "acme/fast" })], ecosystem: [] },
    new Set(),
  );
  const text = formatDigest(sel, new Date("2026-10-26T01:00:00Z"));

  assert.match(text, /AI Infra \/ 推理 日报/);
  assert.match(text, /acme\/fast/);
  // The repository's own words, unmodified.
  assert.match(text, /A fast LLM inference engine with KV-cache/);
  assert.match(text, /\+.*★\/天/);
  assert.match(text, /数据来自 GitHub Search API/);
});

test("an empty selection says so instead of showing a blank message", () => {
  const text = formatDigest({ fresh: [], ecosystem: [] }, new Date("2026-10-26T01:00:00Z"));
  assert.match(text, /没有符合条件的新条目/);
});

test("missing or unidentifiable license is stated, not omitted", () => {
  for (const license of [null, "NOASSERTION"]) {
    const sel = selectRepos({ fresh: [repo({ license })], ecosystem: [] }, new Set());
    const text = formatDigest(sel, new Date("2026-10-26T01:00:00Z"));
    assert.match(text, /license 不明确/, `license=${license} was not flagged`);
  }
});

test("a normal license is shown as-is", () => {
  const sel = selectRepos({ fresh: [repo({ license: "MIT" })], ecosystem: [] }, new Set());
  assert.match(formatDigest(sel, new Date("2026-10-26T01:00:00Z")), /MIT/);
});
