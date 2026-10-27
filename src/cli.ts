#!/usr/bin/env node
/**
 * Send text or an image from the command line — useful for cron jobs, CI
 * notifications, and testing the upload pipeline without touching the bot.
 *
 *   node src/cli.ts text --chat oc_xxx "build done"
 *   node src/cli.ts image --chat oc_xxx --file assets/sample.png
 *   node src/cli.ts upload --file assets/sample.png   # prints the image_key
 */
import * as lark from "@larksuiteoapi/node-sdk";

import { FeishuMessenger } from "./feishu.ts";
import { readConfig } from "./config.ts";
import { isEntryPoint } from "./util.ts";

interface Args {
  command: string;
  chat?: string;
  file?: string;
  text?: string;
}

function parse(argv: string[]): Args {
  const [command = "", ...rest] = argv;
  const args: Args = { command };
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--chat") args.chat = rest[++i];
    else if (token === "--file") args.file = rest[++i];
    else if (token !== undefined) positional.push(token);
  }
  if (positional.length) args.text = positional.join(" ");
  return args;
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  const { appId, appSecret } = readConfig();
  const messenger = new FeishuMessenger(new lark.Client({ appId, appSecret }));

  switch (args.command) {
    case "upload": {
      if (!args.file) throw new Error("upload needs --file");
      const key = await messenger.uploadImage(args.file);
      console.log(key);
      return;
    }
    case "text": {
      if (!args.chat || !args.text) throw new Error("text needs --chat and a message");
      const ids = await messenger.sendText(args.chat, args.text);
      console.log(`sent ${ids.length} message(s): ${ids.join(", ")}`);
      return;
    }
    case "image": {
      if (!args.chat || !args.file) throw new Error("image needs --chat and --file");
      const id = await messenger.sendImage(args.chat, args.file);
      console.log(`sent image: ${id}`);
      return;
    }
    default:
      console.log(
        [
          "usage:",
          "  cli.ts upload --file <path>",
          "  cli.ts text   --chat <chat_id> <message>",
          "  cli.ts image  --chat <chat_id> --file <path>",
        ].join("\n"),
      );
  }
}

if (isEntryPoint(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error("failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
