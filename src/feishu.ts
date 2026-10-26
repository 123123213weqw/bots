/**
 * Outbound message pipeline: text, images, files.
 *
 * Sending an image is a two-step dance — the platform will not accept bytes in
 * the message body:
 *
 *   1. POST /open-apis/im/v1/images   (multipart, image_type=message)
 *        -> { image_key: "img_v3_..." }
 *   2. POST /open-apis/im/v1/messages (msg_type=image, content={"image_key":...})
 *
 * Step 1 needs the `im:resource` scope (or `im:resource:upload`), which is a
 * *different* scope from the messaging ones. `im:message:send_as_bot` alone is
 * not enough and the error is an unhelpful 99991672.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

import { LruCache, chunk } from "./util.ts";

/** Hard platform limits; checked before the round trip so failures are local. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
export const MAX_TEXT_CHARS = 4000;

export const IMAGE_EXTENSIONS = [
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".ico", ".tiff", ".tif", ".heic",
] as const;

export type MediaSource = string | Uint8Array;

export interface Media {
  readonly bytes: Buffer;
  readonly name: string;
  readonly mime: string;
}

export class FeishuError extends Error {
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "FeishuError";
    this.code = code;
  }
}

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
  ".ico": "image/x-icon", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".heic": "image/heic", ".pdf": "application/pdf", ".txt": "text/plain",
  ".zip": "application/zip", ".json": "application/json", ".csv": "text/csv",
};

export function readMedia(
  source: MediaSource,
  kind: "image" | "file",
  name?: string,
): Media {
  let bytes: Buffer;
  let filename: string;
  if (typeof source === "string") {
    const stat = statSync(source);
    if (!stat.isFile()) throw new FeishuError(`not a file: ${source}`);
    bytes = readFileSync(source);
    filename = basename(source);
  } else {
    bytes = Buffer.from(source);
    filename = name ?? (kind === "image" ? "image.png" : "file.bin");
  }
  if (bytes.byteLength === 0) throw new FeishuError(`${kind} is empty`);
  const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  if (bytes.byteLength > limit) {
    throw new FeishuError(
      `${kind} is ${(bytes.byteLength / 1048576).toFixed(1)} MB, limit is ${limit / 1048576} MB`,
    );
  }
  if (kind === "image") {
    const ext = extname(filename).toLowerCase();
    if (ext && !(IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new FeishuError(
        `unsupported image extension "${ext}" — allowed: ${IMAGE_EXTENSIONS.join(" ")}`,
      );
    }
  }
  const ext = extname(filename).toLowerCase();
  return { bytes, name: filename, mime: MIME[ext] ?? "application/octet-stream" };
}

/** The platform refuses to deliver an event unless handled within 3s, so the
 *  handler runs against this narrow interface and can be swapped in tests. */
export interface Messenger {
  sendText(chatId: string, text: string, dedupeKey?: string): Promise<string[]>;
  replyText(messageId: string, text: string, dedupeKey?: string): Promise<string[]>;
  sendImage(chatId: string, source: MediaSource, dedupeKey?: string): Promise<string>;
  replyImage(messageId: string, source: MediaSource, dedupeKey?: string): Promise<string>;
  uploadImage(source: MediaSource): Promise<string>;
  downloadMessageImage(messageId: string, fileKey: string): Promise<Buffer>;
}

interface RawResponse {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * The SDK unwraps the response envelope for some endpoints (im.v1.image) and
 * returns it whole for others (im.v1.message). Normalise instead of guessing.
 */
function unwrap(response: unknown): RawResponse {
  const res = (response ?? {}) as RawResponse;
  const code = typeof res.code === "number" ? res.code : 0;
  if (code !== 0) {
    throw new FeishuError(res.msg ?? `feishu error ${code}`, code);
  }
  if (res.data && typeof res.data === "object") return res.data as RawResponse;
  return res;
}

/** Deterministic uuid so the platform itself drops duplicate sends. */
function dedupeUuid(key: string, index = 0): string {
  return createHash("sha256").update(`${key}:${index}`).digest("hex").slice(0, 32);
}

/** eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Sdk = any;

export class FeishuMessenger implements Messenger {
  #sdk: Sdk;
  #imageKeys = new LruCache<string>(100);
  #fileKeys = new LruCache<string>(100);

  constructor(sdk: Sdk) {
    this.#sdk = sdk;
  }

  // ---- text --------------------------------------------------------------
  async sendText(chatId: string, text: string, dedupeKey?: string): Promise<string[]> {
    return this.#send(chatId, "text", JSON.stringify({ text }), dedupeKey);
  }

  async replyText(messageId: string, text: string, dedupeKey?: string): Promise<string[]> {
    return this.#reply(messageId, "text", JSON.stringify({ text }), dedupeKey);
  }

  async #send(
    chatId: string, msgType: string, body: string, dedupeKey?: string,
  ): Promise<string[]> {
    const ids: string[] = [];
    const parts = splitFor(msgType, body);
    for (const [index, part] of parts.entries()) {
      const data: Record<string, string> = {
        receive_id: chatId,
        msg_type: msgType,
        content: part,
      };
      if (dedupeKey) data["uuid"] = dedupeUuid(dedupeKey, index);
      const res = unwrap(
        await this.#sdk.im.v1.message.create({
          params: { receive_id_type: "chat_id" },
          data,
        }),
      );
      ids.push(String(res["message_id"] ?? ""));
    }
    return ids;
  }

  async #reply(
    messageId: string, msgType: string, body: string, dedupeKey?: string,
  ): Promise<string[]> {
    const ids: string[] = [];
    const parts = splitFor(msgType, body);
    for (const [index, part] of parts.entries()) {
      const data: Record<string, string> = { msg_type: msgType, content: part };
      if (dedupeKey) data["uuid"] = dedupeUuid(dedupeKey, index);
      const res = unwrap(
        await this.#sdk.im.v1.message.reply({
          path: { message_id: messageId },
          data,
        }),
      );
      ids.push(String(res["message_id"] ?? ""));
    }
    return ids;
  }

  // ---- images ------------------------------------------------------------
  /** Upload once per unique content; the key is reusable across messages. */
  async uploadImage(source: MediaSource): Promise<string> {
    const media = readMedia(source, "image");
    const hash = createHash("sha256").update(media.bytes).digest("hex");
    const cached = this.#imageKeys.get(hash);
    if (cached) return cached;

    const res = unwrap(
      await this.#sdk.im.v1.image.create({
        data: { image_type: "message", image: media.bytes },
      }),
    );
    const imageKey = res["image_key"];
    if (typeof imageKey !== "string" || !imageKey) {
      throw new FeishuError("upload returned no image_key");
    }
    this.#imageKeys.set(hash, imageKey);
    return imageKey;
  }

  async sendImage(chatId: string, source: MediaSource, dedupeKey?: string): Promise<string> {
    const imageKey = await this.uploadImage(source);
    const [id] = await this.#send(
      chatId, "image", JSON.stringify({ image_key: imageKey }), dedupeKey,
    );
    return id ?? "";
  }

  async replyImage(messageId: string, source: MediaSource, dedupeKey?: string): Promise<string> {
    const imageKey = await this.uploadImage(source);
    const [id] = await this.#reply(
      messageId, "image", JSON.stringify({ image_key: imageKey }), dedupeKey,
    );
    return id ?? "";
  }

  // ---- inbound media -----------------------------------------------------
  /** Files the user sent are fetched by message_id + file_key, not by URL. */
  async downloadMessageImage(messageId: string, fileKey: string): Promise<Buffer> {
    const res = await this.#sdk.im.v1.messageResource.get({
      params: { type: "image" },
      path: { message_id: messageId, file_key: fileKey },
    });
    const stream = res.getReadableStream() as NodeJS.ReadableStream;
    const chunks: Buffer[] = [];
    for await (const part of stream) chunks.push(Buffer.from(part as Uint8Array));
    return Buffer.concat(chunks);
  }
}

function splitFor(msgType: string, body: string): string[] {
  if (msgType !== "text") return [body];
  let text: string;
  try {
    text = String((JSON.parse(body) as { text?: string }).text ?? "");
  } catch {
    return [body];
  }
  return chunk(text, MAX_TEXT_CHARS).map((part) =>
    JSON.stringify({ text: part }),
  );
}
