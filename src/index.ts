#!/usr/bin/env node
/**
 * Entry point: open the long connection and wire events to the handler.
 *
 * The receive event has a 3-second budget; Bot only enqueues, so the model call
 * may take as long as it needs without triggering platform retries.
 */
import * as lark from "@larksuiteoapi/node-sdk";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Bot } from "./bot.ts";
import { FeishuMessenger } from "./feishu.ts";
import { createHandler } from "./handler.ts";
import { deepSeekFromEnv } from "./llm.ts";
import { loadEnv, readConfig } from "./config.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE_IMAGE = join(ROOT, "assets", "sample.png");

async function main(): Promise<void> {
  // Must run before anything reads process.env: a model client created earlier
  // would bind to an empty key and the bot would silently sit in echo mode
  // while every health check still looked fine.
  loadEnv();

  const { appId, appSecret } = readConfig();
  const sdk = new lark.Client({ appId, appSecret });
  const messenger = new FeishuMessenger(sdk);

  const llm = deepSeekFromEnv();
  const handler = createHandler({
    llm,
    imagePath: SAMPLE_IMAGE,
    systemPrompt: process.env.BOT_SYSTEM_PROMPT?.trim() || undefined,
    secret: process.env.DEEPSEEK_API_KEY ?? "",
  });

  const bot = new Bot(messenger, handler, {
    mode: process.env.BOT_REPLY_MODE === "send" ? "send" : "reply",
  });

  const dispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (event) => {
      bot.onEvent(event as never);
      return undefined;
    },
  });

  const ws = new lark.WSClient({
    appId,
    appSecret,
    loggerLevel: lark.LoggerLevel.info,
    onReady: () => console.info("connection ready"),
    onError: (error) => console.error("connection error", error),
    onReconnecting: () => console.warn("connection lost, reconnecting"),
    onReconnected: () => console.info("connection restored"),
  });

  console.info(
    `connecting app_id=${appId} llm=${llm ? llm.model : "none (echo mode)"}`,
  );
  await ws.start({ eventDispatcher: dispatcher });

  const shutdown = async (signal: string): Promise<void> => {
    console.info(`${signal} received, draining in-flight work`);
    await bot.whenIdle();
    ws.close({ force: true });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error("fatal:", error);
  process.exit(1);
});
