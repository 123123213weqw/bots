import assert from "node:assert/strict";
import { test } from "node:test";

import { SandboxRuntime, RuntimeError, runtimeFromEnv } from "../src/runtime.ts";

/** Minimal fetch stub: records requests, replies from a queue. */
function fakeFetch(
  responses: Array<{ status: number; body: unknown }>,
): { impl: typeof fetch; calls: Array<{ url: string; body?: unknown; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; body?: unknown; headers: Record<string, string> }> = [];
  let index = 0;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const entry: { url: string; body?: unknown; headers: Record<string, string> } = {
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    if (init?.body) entry.body = JSON.parse(String(init.body));
    calls.push(entry);

    const next = responses[index] ?? responses.at(-1);
    index += 1;
    const status = next?.status ?? 200;
    return new Response(JSON.stringify(next?.body ?? {}), { status });
  }) as typeof fetch;
  return { impl, calls };
}

function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

// ---- authorisation: the security boundary -----------------------------------

test("an empty allowlist denies everyone, not everyone", () => {
  const runtime = new SandboxRuntime({ baseUrl: "http://127.0.0.1:3082", allowlist: [] });
  assert.equal(runtime.isAllowed("ou_someone"), false);
  assert.equal(runtime.isAllowed(undefined), false);
  assert.equal(runtime.configured, false, "no allowlist means not configured");
});

test("only listed open_ids are allowed", () => {
  const runtime = new SandboxRuntime({
    baseUrl: "http://127.0.0.1:3082",
    allowlist: ["ou_me"],
  });
  assert.equal(runtime.isAllowed("ou_me"), true);
  assert.equal(runtime.isAllowed("ou_someone_else"), false);
  assert.equal(runtime.isAllowed(undefined), false, "missing id must not pass");
  assert.equal(runtime.configured, true);
});

test("a near-miss id is not accepted", () => {
  const runtime = new SandboxRuntime({
    baseUrl: "http://127.0.0.1:3082",
    allowlist: ["ou_me"],
  });
  assert.equal(runtime.isAllowed("ou_m"), false);
  assert.equal(runtime.isAllowed("ou_me "), false);
  assert.equal(runtime.isAllowed("OU_ME"), false);
});

test("runtimeFromEnv is null without a base URL", () => {
  assert.equal(runtimeFromEnv({}), null);
  assert.equal(runtimeFromEnv({ SANDBOX_ALLOWLIST: "ou_me" }), null);
});

test("runtimeFromEnv parses a comma list and trims it", () => {
  const runtime = runtimeFromEnv({
    SANDBOX_BASE_URL: "http://127.0.0.1:3082/",
    SANDBOX_ALLOWLIST: " ou_a , ou_b ,, ",
  });
  assert.ok(runtime);
  assert.equal(runtime.allowlistSize, 2);
  assert.equal(runtime.isAllowed("ou_a"), true);
  assert.equal(runtime.isAllowed("ou_b"), true);
});

// ---- transport --------------------------------------------------------------

test("run submits then polls until the status changes", async () => {
  const { impl, calls } = fakeFetch([
    { status: 202, body: { sessionId: "fs-oc_1" } },
    { status: 200, body: { status: "unknown" } },
    { status: 200, body: { status: "unknown" } },
    { status: 200, body: { status: "done", finalText: "42" } },
  ]);
  const runtime = new SandboxRuntime({
    baseUrl: "http://127.0.0.1:3082",
    allowlist: ["ou_me"],
    pollIntervalMs: 1,
  });

  const result = await withFetch(impl, () =>
    runtime.run({ chatId: "oc_1", messageId: "om_1", text: "count files" }),
  );

  assert.deepEqual(result, { status: "done", finalText: "42" });
  assert.equal(calls[0]?.url, "http://127.0.0.1:3082/tasks");
  const submitted = calls[0]?.body as { chat_id: string; message_id: string; text: string };
  assert.equal(submitted.chat_id, "oc_1");
  assert.equal(submitted.message_id, "om_1", "message_id is the idempotency key");
  assert.equal(submitted.text, "count files");
  assert.match(calls[1]?.url ?? "", /\/results\/fs-oc_1$/);
});

test("the bearer secret is sent when configured", async () => {
  const { impl, calls } = fakeFetch([
    { status: 202, body: { sessionId: "s" } },
    { status: 200, body: { status: "done", finalText: "ok" } },
  ]);
  const runtime = new SandboxRuntime({
    baseUrl: "http://127.0.0.1:3082",
    secret: "s3cret",
    allowlist: ["ou_me"],
    pollIntervalMs: 1,
  });
  await withFetch(impl, () =>
    runtime.run({ chatId: "c", messageId: "m", text: "t" }),
  );
  assert.equal(calls[0]?.headers["authorization"], "Bearer s3cret");
});

test("a 401 from the host surfaces as a RuntimeError with the status", async () => {
  const { impl } = fakeFetch([{ status: 401, body: { error: "鉴权失败" } }]);
  const runtime = new SandboxRuntime({
    baseUrl: "http://127.0.0.1:3082",
    allowlist: ["ou_me"],
  });
  await assert.rejects(
    () => withFetch(impl, () => runtime.run({ chatId: "c", messageId: "m", text: "t" })),
    (error: unknown) => error instanceof RuntimeError && error.status === 401,
  );
});

test("an unreachable host is reported, not thrown as a raw fetch error", async () => {
  const failing = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const runtime = new SandboxRuntime({
    baseUrl: "http://127.0.0.1:3082",
    allowlist: ["ou_me"],
  });
  await assert.rejects(
    () => withFetch(failing, () => runtime.run({ chatId: "c", messageId: "m", text: "t" })),
    (error: unknown) =>
      error instanceof RuntimeError && /unreachable/.test(error.message),
  );
});

test("a task that never finishes times out instead of hanging forever", async () => {
  const { impl } = fakeFetch([
    { status: 202, body: { sessionId: "slow" } },
    { status: 200, body: { status: "unknown" } },
  ]);
  const runtime = new SandboxRuntime({
    baseUrl: "http://127.0.0.1:3082",
    allowlist: ["ou_me"],
    pollIntervalMs: 1,
    timeoutMs: 40,
  });
  await assert.rejects(
    () => withFetch(impl, () => runtime.run({ chatId: "c", messageId: "m", text: "t" })),
    /timed out/,
  );
});

test("a submission with no sessionId is an error", async () => {
  const { impl } = fakeFetch([{ status: 202, body: { error: "text 为空" } }]);
  const runtime = new SandboxRuntime({
    baseUrl: "http://127.0.0.1:3082",
    allowlist: ["ou_me"],
  });
  await assert.rejects(
    () => withFetch(impl, () => runtime.run({ chatId: "c", messageId: "m", text: "t" })),
    /text 为空/,
  );
});

test("reset bumps the generation so the host derives a new session", async () => {
  const { impl, calls } = fakeFetch([
    { status: 202, body: { sessionId: "s1" } },
    { status: 200, body: { status: "done", finalText: "a" } },
    { status: 202, body: { sessionId: "s2" } },
    { status: 200, body: { status: "done", finalText: "b" } },
  ]);
  const runtime = new SandboxRuntime({
    baseUrl: "http://127.0.0.1:3082",
    allowlist: ["ou_me"],
    pollIntervalMs: 1,
  });

  await withFetch(impl, () => runtime.run({ chatId: "oc_1", messageId: "m1", text: "x" }));
  const first = calls[0]?.body as { workspace: string };
  assert.equal(first.workspace, "oc_1", "首次用 chat_id 本身");

  runtime.reset("oc_1");
  await withFetch(impl, () => runtime.run({ chatId: "oc_1", messageId: "m2", text: "y" }));
  const second = calls.find((c) => (c.body as { message_id?: string })?.message_id === "m2")
    ?.body as { workspace: string };
  assert.equal(second.workspace, "oc_1-g1", "重置后必须换 workspace 才换得了 session");
  assert.notEqual(second.workspace, first.workspace);
});

test("resets are per chat", () => {
  const runtime = new SandboxRuntime({ baseUrl: "http://127.0.0.1:3082", allowlist: ["ou_me"] });
  runtime.reset("oc_a");
  assert.equal(runtime.workspaceFor("oc_a"), "oc_a-g1");
  assert.equal(runtime.workspaceFor("oc_b"), "oc_b");
});
