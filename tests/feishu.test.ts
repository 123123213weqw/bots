import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FeishuError, FeishuMessenger, readMedia } from "../src/feishu.ts";

interface Call {
  method: string;
  payload: unknown;
}

/** Minimal stand-in for the SDK surface FeishuMessenger touches. */
function fakeSdk(options: { envelope?: "flat" | "wrapped"; failCreate?: boolean } = {}) {
  const calls: Call[] = [];
  let uploads = 0;
  const sdk = {
    im: {
      v1: {
        image: {
          create: async (payload: unknown) => {
            uploads += 1;
            calls.push({ method: "image.create", payload });
            return options.envelope === "wrapped"
              ? { code: 0, msg: "ok", data: { image_key: "img_v3_fake" } }
              : { image_key: "img_v3_fake" };
          },
        },
        message: {
          create: async (payload: unknown) => {
            calls.push({ method: "message.create", payload });
            if (options.failCreate) return { code: 230001, msg: "invalid receive_id" };
            return { code: 0, msg: "ok", data: { message_id: "om_sent" } };
          },
          reply: async (payload: unknown) => {
            calls.push({ method: "message.reply", payload });
            return { code: 0, msg: "ok", data: { message_id: "om_replied" } };
          },
        },
        messageResource: {
          get: async (payload: unknown) => {
            calls.push({ method: "messageResource.get", payload });
            return {
              getReadableStream: () =>
                (async function* () {
                  yield Buffer.from("fake-bytes");
                })(),
            };
          },
        },
      },
    },
  };
  return { sdk, calls, uploads: () => uploads };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function tempPng(): string {
  const dir = mkdtempSync(join(tmpdir(), "bots-"));
  const file = join(dir, "shot.png");
  writeFileSync(file, PNG);
  return file;
}

test("text send: chunked, each chunk carries content and uuid", async () => {
  const { sdk, calls } = fakeSdk();
  const messenger = new FeishuMessenger(sdk);
  const ids = await messenger.sendText("oc_1", "x".repeat(9000), "om_key");

  assert.equal(ids.length, 3);
  const bodies = calls
    .filter((c) => c.method === "message.create")
    .map((c) => (c.payload as { data: { content: string; uuid?: string } }).data);
  assert.deepEqual(bodies.map((b) => JSON.parse(b.content).text.length), [4000, 4000, 1000]);
  // Distinct uuid per chunk: identical uuids would make the platform drop parts.
  assert.equal(new Set(bodies.map((b) => b.uuid)).size, 3);
  assert.equal((calls[0]?.payload as { params: { receive_id_type: string } }).params.receive_id_type, "chat_id");
});

test("image send: uploads once, then reuses the key", async () => {
  const { sdk, calls, uploads } = fakeSdk();
  const messenger = new FeishuMessenger(sdk);
  const file = tempPng();

  const first = await messenger.sendImage("oc_1", file);
  const second = await messenger.sendImage("oc_1", file);

  assert.equal(uploads(), 1, "second send should hit the cache");
  assert.equal(first, "om_sent");
  assert.equal(second, "om_sent");

  const imageBodies = calls
    .filter((c) => (c.payload as { data?: { msg_type?: string } }).data?.msg_type === "image")
    .map((c) => JSON.parse((c.payload as { data: { content: string } }).data.content));
  assert.deepEqual(imageBodies, [{ image_key: "img_v3_fake" }, { image_key: "img_v3_fake" }]);
});

test("image upload: accepts a wrapped response envelope too", async () => {
  const { sdk } = fakeSdk({ envelope: "wrapped" });
  const messenger = new FeishuMessenger(sdk);
  assert.equal(await messenger.uploadImage(tempPng()), "img_v3_fake");
});

test("reply returns the reply message id", async () => {
  const { sdk } = fakeSdk();
  const messenger = new FeishuMessenger(sdk);
  assert.deepEqual(await messenger.replyText("om_in", "hi"), ["om_replied"]);
});

test("non-zero code becomes a FeishuError carrying the code", async () => {
  const { sdk } = fakeSdk({ failCreate: true });
  const messenger = new FeishuMessenger(sdk);
  await assert.rejects(
    () => messenger.sendText("oc_bad", "hi"),
    (error: unknown) =>
      error instanceof FeishuError && error.code === 230001 && /invalid receive_id/.test(error.message),
  );
});

test("media validation runs before the network call", () => {
  assert.throws(() => readMedia(Buffer.alloc(0), "image"), /empty/);
  assert.throws(
    () => readMedia(Buffer.alloc(10 * 1024 * 1024 + 1), "image"),
    /limit is 10 MB/,
  );
  // SVG is not on the platform's accepted list, and uploads would fail late.
  assert.throws(
    () => readMedia(PNG, "image", "notes.svg"),
    (error: unknown) => error instanceof FeishuError && /unsupported image extension/.test(error.message),
  );
});

test("media: heic is allowed, mime is guessed", () => {
  const media = readMedia(PNG, "image", "photo.HEIC");
  assert.equal(media.mime, "image/heic");
  assert.equal(media.name, "photo.HEIC");
});

test("media: file kind accepts a larger budget and unknown extensions", () => {
  const media = readMedia(Buffer.alloc(1024), "file", "report.xyz");
  assert.equal(media.mime, "application/octet-stream");
});

test("inbound image download streams into a buffer", async () => {
  const { sdk } = fakeSdk();
  const messenger = new FeishuMessenger(sdk);
  const bytes = await messenger.downloadMessageImage("om_1", "img_key");
  assert.equal(bytes.toString(), "fake-bytes");
});
