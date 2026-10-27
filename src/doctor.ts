#!/usr/bin/env node
/**
 * Config doctor: verify the credentials the bot depends on, in about two
 * seconds, without printing any of them.
 *
 * Exists because a shared key can rotate out from under you. When it does, the
 * bot does not crash -- it degrades (echo mode, or "模型暂时不可用") and every
 * health check still looks green. This turns "why is it dumb today" into one
 * command with a clear verdict.
 *
 *   node src/doctor.ts          # add --json for machine-readable output
 *
 * Exit code is 0 only when every check passes, so it can gate a deploy.
 */
import { readConfig } from "./config.ts";
import { isEntryPoint } from "./util.ts";
import { DeepSeek, redact } from "./llm.ts";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const TIMEOUT_MS = 15_000;

async function checkFeishu(appId: string, appSecret: string): Promise<Check> {
  try {
    const response = await fetch(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    const body = (await response.json()) as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    };
    if (body.code !== 0 || !body.tenant_access_token) {
      return {
        name: "feishu credentials",
        ok: false,
        detail: `code=${body.code} ${redact(body.msg ?? "", appSecret)}`,
      };
    }
    // Report the token's shape, never the token.
    return {
      name: "feishu credentials",
      ok: true,
      detail: `token ok (${body.tenant_access_token.length} chars, ${body.expire}s)`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { name: "feishu credentials", ok: false, detail: redact(reason, appSecret) };
  }
}

async function checkModel(): Promise<Check> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    return {
      name: "deepseek key",
      ok: false,
      detail: "not set — the bot will run in echo mode",
    };
  }
  const model = process.env.DEEPSEEK_MODEL?.trim() || "deepseek-chat";
  const llm = new DeepSeek({
    apiKey,
    baseUrl: process.env.DEEPSEEK_BASE_URL?.trim() || undefined,
    model,
    maxTokens: 8,
    timeoutMs: TIMEOUT_MS,
  });
  const started = Date.now();
  try {
    const answer = await llm.chat([{ role: "user", content: "回复一个字：好" }]);
    return {
      name: "deepseek key",
      ok: true,
      detail: `${model} replied in ${Date.now() - started}ms`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { name: "deepseek key", ok: false, detail: redact(reason, apiKey) };
  }
}

async function main(): Promise<number> {
  const checks: Check[] = [];

  let config: { appId: string; appSecret: string } | null = null;
  try {
    config = readConfig();
    checks.push({
      name: "feishu env",
      ok: true,
      detail: `app_id present, secret ${config.appSecret.length} chars`,
    });
  } catch (error) {
    checks.push({
      name: "feishu env",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (config) checks.push(await checkFeishu(config.appId, config.appSecret));
  checks.push(await checkModel());

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ checks, ok: checks.every((c) => c.ok) }, null, 2));
  } else {
    for (const check of checks) {
      console.log(`${check.ok ? "ok  " : "FAIL"}  ${check.name.padEnd(20)} ${check.detail}`);
    }
  }
  return checks.every((c) => c.ok) ? 0 : 1;
}

// Guarded: importing this module (from a test or a smoke check) must not run
// credential probes against the network.
if (isEntryPoint(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error("doctor crashed:", error instanceof Error ? error.message : error);
      process.exit(2);
    },
  );
}
