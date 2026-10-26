import assert from "node:assert/strict";
import { test } from "node:test";

import { DeepSeek, LlmError, deepSeekFromEnv, redact } from "../src/llm.ts";

const KEY = "sk-test-0123456789abcdef0123456789";

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(
  reply: { ok: boolean; status: number; body: string },
  sink: Captured[] = [],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    sink.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return new Response(reply.body, { status: reply.status });
  }) as typeof fetch;
}

function ok(content: string) {
  return { ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content } }] }) };
}

test("sends an OpenAI-compatible request with bearer auth", async () => {
  const sink: Captured[] = [];
  const llm = new DeepSeek({ apiKey: KEY, fetchImpl: fakeFetch(ok("hi there"), sink) });

  const answer = await llm.chat([{ role: "user", content: "hello" }]);

  assert.equal(answer, "hi there");
  assert.equal(sink[0]?.url, "https://api.deepseek.com/chat/completions");
  assert.equal(sink[0]?.headers["authorization"], `Bearer ${KEY}`);
  const body = sink[0]?.body as { model: string; messages: unknown[]; stream: boolean };
  assert.equal(body.model, "deepseek-chat");
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages, [{ role: "user", content: "hello" }]);
});

test("base url and model are configurable, trailing slash tolerated", async () => {
  const sink: Captured[] = [];
  const llm = new DeepSeek({
    apiKey: KEY,
    baseUrl: "https://proxy.example.com/v1/",
    model: "deepseek-reasoner",
    fetchImpl: fakeFetch(ok("x"), sink),
  });
  await llm.chat([{ role: "user", content: "q" }]);
  assert.equal(sink[0]?.url, "https://proxy.example.com/v1/chat/completions");
  assert.equal((sink[0]?.body as { model: string }).model, "deepseek-reasoner");
});

test("an http error never leaks the key", async () => {
  // Providers sometimes echo the credential back; that must not escape.
  const leaky = `{"error":{"message":"invalid api key ${KEY} supplied"}}`;
  const llm = new DeepSeek({
    apiKey: KEY,
    fetchImpl: fakeFetch({ ok: false, status: 401, body: leaky }),
  });

  await assert.rejects(
    () => llm.chat([{ role: "user", content: "x" }]),
    (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.status, 401);
      assert.ok(!error.message.includes(KEY), "key leaked in error message");
      assert.match(error.message, /redacted/);
      return true;
    },
  );
});

test("a transport failure is wrapped and redacted", async () => {
  const failing = (async () => {
    throw new Error(`connect failed for key ${KEY}`);
  }) as unknown as typeof fetch;
  const llm = new DeepSeek({ apiKey: KEY, fetchImpl: failing });

  await assert.rejects(
    () => llm.chat([{ role: "user", content: "x" }]),
    (error: unknown) =>
      error instanceof LlmError && !error.message.includes(KEY),
  );
});

test("empty or malformed responses are rejected", async () => {
  const empty = new DeepSeek({ apiKey: KEY, fetchImpl: fakeFetch(ok("   ")) });
  await assert.rejects(() => empty.chat([{ role: "user", content: "x" }]), /no content/);

  const junk = new DeepSeek({
    apiKey: KEY,
    fetchImpl: fakeFetch({ ok: true, status: 200, body: "not json" }),
  });
  await assert.rejects(() => junk.chat([{ role: "user", content: "x" }]), /not JSON/);
});

test("redact removes the full key and its tail", () => {
  const text = `a ${KEY} b ${KEY.slice(-8)} c`;
  const out = redact(text, KEY);
  assert.ok(!out.includes(KEY));
  assert.ok(!out.includes(KEY.slice(-8)));
  assert.equal(redact("nothing here", KEY), "nothing here");
  assert.equal(redact("no key configured", ""), "no key configured");
});

test("deepSeekFromEnv is null without a key, configured with one", () => {
  assert.equal(deepSeekFromEnv({}), null);
  assert.equal(deepSeekFromEnv({ DEEPSEEK_API_KEY: "   " }), null);

  const llm = deepSeekFromEnv({
    DEEPSEEK_API_KEY: KEY,
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    DEEPSEEK_MODEL: "deepseek-reasoner",
  });
  assert.ok(llm instanceof DeepSeek);
  assert.equal(llm.model, "deepseek-reasoner");
});
