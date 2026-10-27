import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FileError,
  assertFileSize,
  classify,
  contentHash,
  extensionOf,
  formatFileOverview,
  sanitizeFileName,
  summarizeText,
} from "../src/files.ts";

// ---- filename sanitisation: the untrusted field ------------------------------

test("path traversal is reduced to a bare name", () => {
  assert.equal(sanitizeFileName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFileName("/etc/shadow"), "shadow");
  assert.equal(sanitizeFileName("C:\\Windows\\system32\\cmd.exe"), "cmd.exe");
  assert.equal(sanitizeFileName("a/b/c/report.csv"), "report.csv");
});

test("hidden and dot-only names cannot escape", () => {
  assert.equal(sanitizeFileName(".."), "未命名文件");
  assert.equal(sanitizeFileName("."), "未命名文件");
  assert.equal(sanitizeFileName("..."), "未命名文件");
  assert.equal(sanitizeFileName(".bashrc"), "bashrc");
});

test("control characters and NUL are stripped", () => {
  const cleaned = sanitizeFileName("re\u0000port\u001b[31m.txt");
  assert.doesNotMatch(cleaned, /[\u0000-\u001f\u007f]/);
  assert.match(cleaned, /report/);
});

test("absurdly long names are capped", () => {
  const long = "a".repeat(5000) + ".txt";
  assert.ok(sanitizeFileName(long).length <= 120);
});

test("empty or missing names get a placeholder, never an empty string", () => {
  assert.equal(sanitizeFileName(""), "未命名文件");
  assert.equal(sanitizeFileName(undefined), "未命名文件");
  assert.equal(sanitizeFileName(null), "未命名文件");
  assert.equal(sanitizeFileName("   "), "未命名文件");
});

// ---- size guards ------------------------------------------------------------

test("empty files are refused", () => {
  assert.throws(() => assertFileSize(0), FileError);
  assert.throws(() => assertFileSize(0), /空/);
});

test("oversized files are refused before anything is decoded", () => {
  assert.throws(() => assertFileSize(30 * 1024 * 1024 + 1), /超过上限/);
  assert.doesNotThrow(() => assertFileSize(1024));
});

// ---- classification ---------------------------------------------------------

test("extension recognises the usual families", () => {
  assert.equal(classify("a.csv", Buffer.from("x")), "text");
  assert.equal(classify("a.py", Buffer.from("x")), "text");
  assert.equal(classify("a.png", Buffer.from("x")), "image");
  assert.equal(classify("a.pdf", Buffer.from("x")), "pdf");
  assert.equal(classify("a.zip", Buffer.from("x")), "archive");
});

test("a .txt that is actually binary is not decoded as text", () => {
  // Extension lies; the NUL byte decides.
  const binary = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02]);
  assert.equal(classify("payload.txt", binary), "binary");
});

test("extensionless source files are treated as text", () => {
  assert.equal(classify("Makefile", Buffer.from("all:\n\techo hi\n")), "text");
  assert.equal(classify("dockerfile", Buffer.from("FROM x")), "text");
});

test("extensionOf handles odd names without throwing", () => {
  assert.equal(extensionOf("a.tar.gz"), "gz");
  assert.equal(extensionOf("noext"), "");
  assert.equal(extensionOf(".gitignore"), "");
  assert.equal(extensionOf("trailing."), "");
});

// ---- text statistics --------------------------------------------------------

test("line and character counts match what a reader expects", () => {
  const stats = summarizeText(Buffer.from("a\nb\nc\n"));
  assert.equal(stats.lines, 4, "a trailing newline means an empty last line");
  assert.equal(stats.chars, 6);
  assert.equal(stats.bytes, 6);
});

test("CRLF is normalised before counting", () => {
  const stats = summarizeText(Buffer.from("a\r\nb\r\nc"));
  assert.equal(stats.lines, 3);
  assert.doesNotMatch(stats.preview, /\r/);
});

test("CSV column count is detected, including tabs", () => {
  const csv = summarizeText(Buffer.from("name,age,city\nx,1,y\n"));
  assert.equal(csv.columns, 3);
  assert.equal(csv.delimiter, ",");

  const tsv = summarizeText(Buffer.from("a\tb\tc\n1\t2\t3\n"));
  assert.equal(tsv.columns, 3);
  assert.equal(tsv.delimiter, "\t");
});

test("a plain sentence is not mistaken for delimited data", () => {
  const stats = summarizeText(Buffer.from("这是一段普通文字，没有列。\n"));
  assert.equal(stats.columns, null);
});

test("an empty file summarises to zeroes instead of throwing", () => {
  // assertFileSize rejects empty uploads; summarise must still be total.
  const stats = summarizeText(Buffer.alloc(0));
  assert.equal(stats.lines, 0);
  assert.equal(stats.chars, 0);
});

test("large text is truncated and says so", () => {
  const big = Buffer.from("x".repeat(300 * 1024));
  const stats = summarizeText(big);
  assert.equal(stats.truncated, true);
  assert.ok(stats.preview.length <= 600);
});

test("invalid UTF-8 does not throw", () => {
  const stats = summarizeText(Buffer.from([0xff, 0xfe, 0x41, 0x42]));
  assert.ok(typeof stats.preview === "string");
});

// ---- presentation -----------------------------------------------------------

test("overview carries name, size and statistics", () => {
  const text = formatFileOverview("sales.csv", "text", {
    bytes: 2048, lines: 10, chars: 500, columns: 4, delimiter: ",", truncated: false,
    preview: "a,b,c,d",
  });
  assert.match(text, /sales\.csv/);
  assert.match(text, /2\.0 KB/);
  assert.match(text, /10 行/);
  assert.match(text, /4 列（逗号分隔）/);
});

test("truncation is disclosed, not hidden", () => {
  const text = formatFileOverview("big.log", "text", {
    bytes: 999999, lines: 1, chars: 1, columns: null, delimiter: null,
    truncated: true, preview: "x",
  });
  assert.match(text, /仅分析前部分/);
});

test("unsupported kinds say so instead of pretending", () => {
  const text = formatFileOverview("a.pdf", "pdf", { bytes: 1234 });
  assert.match(text, /PDF/);
  assert.match(text, /暂不解析/);
});

test("content hash is stable and short", () => {
  const a = contentHash(Buffer.from("hello"));
  const b = contentHash(Buffer.from("hello"));
  assert.equal(a, b);
  assert.equal(a.length, 32);
  assert.notEqual(a, contentHash(Buffer.from("hello!")));
});
