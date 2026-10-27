/**
 * Inbound file handling.
 *
 * Everything here assumes the file is hostile. A chat upload is an untrusted
 * input from a remote user: the name can contain path separators, the content
 * can be a decompression bomb, and the size can exceed what the process can
 * hold. Nothing is written to disk -- files are processed in memory and dropped
 * -- because a temp directory that outlives the request is how a bot becomes a
 * disk-filling service.
 */
import { createHash } from "node:crypto";

/** Hard ceiling for anything we will even look at. Feishu's own upload cap is
 *  in the same order of magnitude, so this mainly protects the bot from its own
 *  memory use on a shared box. */
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
/** How much of a text file we keep for follow-up questions. */
export const MAX_TEXT_KEEP_BYTES = 200 * 1024;
/** Characters of preview shown to the user. */
const PREVIEW_CHARS = 600;

export class FileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileError";
  }
}

/**
 * Make an uploaded name safe to display and to compare against.
 *
 * Only the last path component survives: "../../etc/passwd" becomes "passwd".
 * Control characters and NUL bytes are dropped, and the result is length-capped
 * so a 10k-character name cannot blow up a log line or a reply.
 */
export function sanitizeFileName(raw: string | undefined | null): string {
  const input = (raw ?? "").toString();
  // Strip anything that could act as a path separator on either platform, then
  // take the tail. Doing the split before the NUL strip keeps "a\0/b" honest.
  const tail = input.split(/[/\\]/).pop() ?? "";
  const cleaned = tail
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "") // no hidden files, no "." / ".."
    .trim();
  if (!cleaned) return "未命名文件";
  return cleaned.slice(0, 120);
}

export type FileKind = "text" | "image" | "pdf" | "archive" | "binary";

const TEXT_EXT = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml",
  "toml", "ini", "cfg", "conf", "log", "xml", "html", "htm", "css", "scss",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt",
  "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "sql", "lua",
  "r", "m", "swift", "scala", "pl", "ex", "exs", "erl", "hs", "clj", "vim",
  "dockerfile", "makefile", "gitignore", "env",
]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "heic"]);
const ARCHIVE_EXT = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"]);

export function extensionOf(name: string): string {
  const at = name.lastIndexOf(".");
  if (at <= 0 || at === name.length - 1) return "";
  return name.slice(at + 1).toLowerCase();
}

/**
 * Decide how to handle a file.
 *
 * Extension alone is not trusted: a ".txt" that is actually binary must not be
 * decoded as text and shown to the user as mojibake. The first bytes decide.
 */
export function classify(name: string, head: Buffer): FileKind {
  const ext = extensionOf(name);
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (ARCHIVE_EXT.has(ext)) return "archive";

  const looksBinary = head.subarray(0, 800).some((b) => b === 0);
  if (looksBinary) return "binary";
  if (TEXT_EXT.has(ext)) return "text";
  // Unknown extension but no NUL bytes: treat as text, since code and data files
  // frequently have no extension at all.
  return "text";
}

export interface TextStats {
  bytes: number;
  /** Lines as a reader counts them, not as a split would. */
  lines: number;
  chars: number;
  /** For delimited files: detected column count, else null. */
  columns: number | null;
  delimiter: string | null;
  /** True when the content was shortened before analysis. */
  truncated: boolean;
  preview: string;
}

const DELIMITERS = [",", "\t", ";", "|"] as const;

/** Pick the delimiter that splits the first non-empty line most consistently. */
function detectDelimiter(firstLine: string): string | null {
  let best: string | null = null;
  let bestCount = 1;
  for (const d of DELIMITERS) {
    const count = firstLine.split(d).length - 1;
    if (count >= 1 && count + 1 > bestCount) {
      bestCount = count + 1;
      best = d;
    }
  }
  return best;
}

export function summarizeText(buffer: Buffer): TextStats {
  const truncated = buffer.byteLength > MAX_TEXT_KEEP_BYTES;
  const slice = truncated ? buffer.subarray(0, MAX_TEXT_KEEP_BYTES) : buffer;
  // Decode once; a lone surrogate at the cut point is removed by Buffer's own
  // replacement, which is ugly but never throws.
  const text = slice.toString("utf8");
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const lines = normalized.length === 0 ? 0 : normalized.split("\n").length;
  const firstLine = normalized.split("\n").find((l) => l.trim().length > 0) ?? "";
  const delimiter = detectDelimiter(firstLine);
  const columns = delimiter ? firstLine.split(delimiter).length : null;

  return {
    bytes: buffer.byteLength,
    lines,
    chars: normalized.length,
    columns,
    delimiter,
    truncated,
    preview: normalized.slice(0, PREVIEW_CHARS),
  };
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

const DELIM_NAMES: Record<string, string> = {
  ",": "逗号", "\t": "制表符", ";": "分号", "|": "竖线",
};

export function formatFileOverview(
  name: string,
  kind: FileKind,
  stats: TextStats | { bytes: number },
): string {
  const size = humanBytes(stats.bytes);
  const head = `${name}  ·  ${size}`;

  if ("lines" in stats) {
    const bits = [`${stats.lines} 行`, `${stats.chars} 字符`];
    if (stats.columns && stats.delimiter) {
      bits.push(`${stats.columns} 列（${DELIM_NAMES[stats.delimiter] ?? stats.delimiter}分隔）`);
    }
    const note = stats.truncated ? `\n（超过 ${humanBytes(MAX_TEXT_KEEP_BYTES)}，仅分析前部分）` : "";
    return `${head}\n${bits.join(" · ")}${note}\n\n${stats.preview}`;
  }

  const why: Record<FileKind, string> = {
    image: "图片",
    pdf: "PDF",
    archive: "压缩包",
    binary: "二进制",
    text: "文本",
  };
  return `${head}\n类型：${why[kind]}\n这个类型目前只做识别，暂不解析内容。`;
}

/** Stable content hash, used to avoid re-processing the same upload twice. */
export function contentHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 32);
}

export function assertFileSize(bytes: number): void {
  if (bytes === 0) throw new FileError("文件是空的");
  if (bytes > MAX_FILE_BYTES) {
    throw new FileError(
      `文件 ${humanBytes(bytes)} 超过上限 ${humanBytes(MAX_FILE_BYTES)}`,
    );
  }
}
