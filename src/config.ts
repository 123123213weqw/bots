/** Minimal .env reader. No dependency, no shell interpolation. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnv(file = resolve(import.meta.dirname, "..", ".env")): void {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const at = trimmed.indexOf("=");
    const key = trimmed.slice(0, at).trim();
    const value = trimmed.slice(at + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

export interface Config {
  appId: string;
  appSecret: string;
}

export function readConfig(): Config {
  loadEnv();
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error(
      "FEISHU_APP_ID / FEISHU_APP_SECRET missing — copy .env.example to .env, " +
        "or run `python console/read_secret.py` to fill it from the console.",
    );
  }
  return { appId, appSecret };
}
