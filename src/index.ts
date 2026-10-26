#!/usr/bin/env node
/**
 * Entry point: open the long connection and wire events to the handler.
 *
 * The `im:message.receive_v1` event is delivered with a 3-second budget; the
 * Bot only enqueues, so this file stays boring on purpose.
 */
import * as lark from "@larksuiteoapi/node-sdk";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Bot } from "./bot.ts";
import type { Incoming, Reply } from "./bot.ts";
import { FeishuMessenger } from "./feishu.ts";
import { readConfig } from "./config.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE_IMAGE = join(ROOT, "assets", "sample.png");

/**
 * Replace this. Everything else in the project is plumbing.
 *
 * Anything you send back is delivered as a reply in the same thread.
 */
async function handler(message: Incoming): Promise<Reply | null> {
  if (message.msgType !== "text") {
    return { kind: "text", text: `暂时只处理文本消息（收到 ${message.msgType}）。` };
  }
  switch (message.text.toLowerCase()) {
    case "":
      return { kind: "text", text: "在，说点什么？" };
    case "ping":
      return { kind: "text", text: "pong" };
    // Demonstrates the whole media pipeline: upload once, then send by key.
    case "图":
    case "图片":
    case "image":
    case "pic":
      return { kind: "image", source: SAMPLE_IMAGE };
    default:
      return { kind: "text", text: `收到：${message.text}` };
  }
}

async function main(): Promise<void> {
  const { appId, appSecret } = readConfig();
  const sdk = new lark.Client({ appId, appSecret });
  const messenger = new FeishuMessenger(sdk);
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

  console.info(`connecting app_id=${appId}`);
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
