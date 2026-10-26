/**
 * Daily digest of GitHub AI-inference infrastructure, delivered to Feishu.
 *
 * Design rules, chosen because the naive version of this is worthless:
 *
 *   1. Everything is fetched live from the GitHub API. A model reciting repos
 *      from memory produces stale names and invented projects; the metadata
 *      here is always real.
 *   2. Descriptions are the repository's own, not a paraphrase. Nothing in the
 *      message is generated text, so nothing in it can be a fabrication.
 *   3. Repos already sent are remembered and skipped, otherwise the digest
 *      recommends ray/vLLM every single day and stops being read.
 *   4. Ranking uses measurable signals (stars per day since creation for new
 *      projects, stars + recency for the ecosystem) rather than vibes.
 *
 * Usage:
 *   node src/digest.ts              # send to DIGEST_CHAT_ID
 *   node src/digest.ts --dry-run    # print only
 *   node src/digest.ts --reset-seen # forget history (for testing)
 */
import * as lark from "@larksuiteoapi/node-sdk";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FeishuMessenger } from "./feishu.ts";
import { loadEnv, readConfig } from "./config.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEEN_FILE = join(HERE, "..", ".state", "digest-seen.json");
/**
 * How long a repo stays "already recommended".
 *
 * A count cap is the wrong bound for a 6-hourly digest: four rounds a day would
 * burn 800 slots in two days. Expiring by age instead means the pool refreshes
 * on a schedule that matches how fast the reader forgets, not how often we run.
 */
const SEEN_TTL_DAYS = 21;
const DAY = 86_400_000;

/**
 * Words that indicate inference / compute *serving* specifically.
 *
 * Deliberately excludes the bare token "llm": matching it let a fine-tuning
 * toolkit (LlamaFactory) into the ecosystem section of a digest about inference
 * serving. A mention of LLMs is not evidence that a project serves them.
 */
const STRONG =
  /inferenc|serving|serve[drs]?\b|vllm|sglang|tensorrt|kv[- ]?cache|paged[- ]?attention|attention|quantiz|\bmlx\b|throughput|continuous[- ]?batch|speculative[- ]?decod|prefill|decode[- ]?kernel|\bmoe\b|transformer|embedding|distillat|\bllama\b/i;

/**
 * Bare "GPU" or "CUDA" is not a signal: it let a general GPU array library
 * (CuPy, "NumPy & SciPy for GPU") into an inference digest through topic:cuda.
 * A project has to mention inference, serving, kernels or model internals.
 */

/**
 * Things that look adjacent but are a different job: training, fine-tuning,
 * datasets, and link farms. A digest that mixes these in stops being about
 * implementation.
 */
const OFF_TOPIC =
  /fine[- ]?tun|pretrain|pre-train|training loop|dataset|awesome[- ]|curated list|tutorial|course\b|roadmap/i;

/** Never show these even if a topic search drags them in. */
const DENY = new Set([
  "gitleaks/gitleaks",
  "liguodongiot/llm-action", // a book/course, not an implementation
]);

export interface Repo {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  language: string | null;
  license: string | null;
  created_at: string;
  pushed_at: string;
  archived: boolean;
}

export interface Selections {
  fresh: Repo[];
  ecosystem: Repo[];
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "bots-digest",
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers["authorization"] = `Bearer ${token}`;
  return headers;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function search(q: string, perPage: number, sort: string): Promise<Repo[]> {
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", q);
  url.searchParams.set("sort", sort);
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", String(perPage));

  // Unauthenticated search allows ~10 requests/minute, and a burst of six
  // queries can trip it. Retry once after the advertised delay instead of
  // silently returning a thin digest.
  let response: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(url, {
      headers: apiHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) break;
    if (response.status !== 403 && response.status !== 429) break;
    const retryAfter = Number(response.headers.get("retry-after") ?? "0");
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : 2_000 * (attempt + 1);
    if (attempt < 2) await sleep(Math.min(waitMs, 10_000));
  }
  if (!response || !response.ok) {
    const status = response?.status ?? 0;
    const hint = status === 403 || status === 429 ? " (rate limited — set GITHUB_TOKEN)" : "";
    throw new Error(`github search failed: ${status}${hint} ${q}`);
  }
  const body = (await response.json()) as { items?: Record<string, unknown>[] };
  return (body.items ?? []).map((item) => ({
    full_name: String(item["full_name"] ?? ""),
    html_url: String(item["html_url"] ?? ""),
    description: (item["description"] as string | null) ?? null,
    stargazers_count: Number(item["stargazers_count"] ?? 0),
    language: (item["language"] as string | null) ?? null,
    license: ((item["license"] as { spdx_id?: string } | null)?.spdx_id) ?? null,
    created_at: String(item["created_at"] ?? ""),
    pushed_at: String(item["pushed_at"] ?? ""),
    archived: Boolean(item["archived"]),
  }));
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
}

/** Is this repo plausibly about inference/compute infrastructure? */
export function isRelevant(repo: Repo): boolean {
  if (repo.archived) return false;
  if (DENY.has(repo.full_name)) return false;
  if (!repo.description) return false;
  if (OFF_TOPIC.test(repo.description)) return false;
  return STRONG.test(`${repo.full_name} ${repo.description}`);
}

/** Stars gained per day since the repository was created. */
export function starsPerDay(repo: Repo, now = Date.now()): number {
  const created = Date.parse(repo.created_at);
  if (!Number.isFinite(created)) return 0;
  const days = Math.max(1, (now - created) / DAY);
  return repo.stargazers_count / days;
}

export function dedupe(repos: Repo[], seen: ReadonlySet<string>): Repo[] {
  const out: Repo[] = [];
  const considered = new Set<string>();
  for (const repo of repos) {
    if (seen.has(repo.full_name) || considered.has(repo.full_name)) continue;
    considered.add(repo.full_name);
    out.push(repo);
  }
  return out;
}

/** Pick `want` repos in order, never repeating one already chosen. */
function take(candidates: Repo[], want: number, chosen: Set<string>): Repo[] {
  const out: Repo[] = [];
  for (const repo of candidates) {
    if (out.length >= want) break;
    if (chosen.has(repo.full_name)) continue;
    chosen.add(repo.full_name);
    out.push(repo);
  }
  return out;
}

export function selectRepos(
  pools: { fresh: Repo[]; ecosystem: Repo[] },
  seen: ReadonlySet<string>,
  wantFresh = 2,
  wantEco = 1,
): Selections {
  const chosen = new Set<string>();
  const fresh = take(dedupe(pools.fresh, seen), wantFresh, chosen);
  const ecosystem = take(dedupe(pools.ecosystem, seen), wantEco, chosen);
  // If one pool is exhausted, fill from the other so the message is not thin.
  const shortfall = wantFresh + wantEco - fresh.length - ecosystem.length;
  if (shortfall > 0) {
    const spare = take(
      dedupe([...pools.fresh, ...pools.ecosystem], seen),
      shortfall,
      chosen,
    );
    ecosystem.push(...spare);
  }
  return { fresh, ecosystem };
}

function fmtStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function line(repo: Repo, index: number, extra: string): string {
  // NOASSERTION means GitHub could not identify the license. For something you
  // might actually deploy, "unclear" is the actionable fact, not the raw enum.
  const license =
    !repo.license || repo.license === "NOASSERTION" ? "license 不明确" : repo.license;
  const meta = [
    `${fmtStars(repo.stargazers_count)}★`,
    repo.language ?? "—",
    license,
    extra,
  ].join(" · ");
  const desc = (repo.description ?? "").replace(/\s+/g, " ").trim();
  return `${index}. ${repo.full_name}\n   ${desc}\n   ${meta}\n   ${repo.html_url}`;
}

export function formatDigest(sel: Selections, date = new Date()): string {
  const stamp = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

  const parts: string[] = [`AI Infra / 推理 日报 · ${stamp}`];

  if (sel.fresh.length) {
    parts.push("\n新项目（近半年创建，按 star 增速）");
    sel.fresh.forEach((repo, i) => {
      parts.push(line(repo, i + 1, `+${starsPerDay(repo).toFixed(1)}★/天`));
    });
  }

  if (sel.ecosystem.length) {
    parts.push("\n活跃生态（近期有提交）");
    sel.ecosystem.forEach((repo, i) => {
      const pushed = repo.pushed_at.slice(0, 10);
      parts.push(line(repo, sel.fresh.length + i + 1, `更新于 ${pushed}`));
    });
  }

  if (!sel.fresh.length && !sel.ecosystem.length) {
    parts.push("\n今天没有符合条件的新条目（已推荐的不会重复）。");
  }

  parts.push("\n数据来自 GitHub Search API，描述为仓库原文，未做改写。");
  return parts.join("\n");
}

type SeenMap = Map<string, number>;

function loadSeen(): SeenMap {
  const seen: SeenMap = new Map();
  let raw: { names?: string[]; entries?: Record<string, number> };
  try {
    raw = JSON.parse(readFileSync(SEEN_FILE, "utf8"));
  } catch {
    return seen;
  }
  const cutoff = Date.now() - SEEN_TTL_DAYS * DAY;
  // Entries recorded before the timestamp format existed have no age, so they
  // are treated as current rather than dropped.
  for (const name of raw.names ?? []) {
    if (!(name in (raw.entries ?? {}))) seen.set(name, Date.now());
  }
  for (const [name, at] of Object.entries(raw.entries ?? {})) {
    if (at >= cutoff) seen.set(name, at);
  }
  return seen;
}

function saveSeen(seen: SeenMap): void {
  const cutoff = Date.now() - SEEN_TTL_DAYS * DAY;
  const entries: Record<string, number> = {};
  for (const [name, at] of seen) {
    if (at >= cutoff) entries[name] = at;
  }
  mkdirSync(dirname(SEEN_FILE), { recursive: true });
  writeFileSync(SEEN_FILE, JSON.stringify({ entries }, null, 2));
}

async function collect(): Promise<{ fresh: Repo[]; ecosystem: Repo[] }> {
  const created = isoDaysAgo(180);
  const active = isoDaysAgo(21);

  // Topic search is noisy (a secret scanner is tagged llm-inference), so query
  // several angles and let isRelevant() do the actual filtering.
  const freshQueries = [
    `topic:llm-inference created:>${created} stars:>150`,
    `topic:inference created:>${created} stars:>150`,
    `topic:model-serving created:>${created} stars:>100`,
    `llm inference in:description,readme created:>${created} stars:>200`,
  ];
  const ecoQueries = [
    `topic:llm-inference stars:>800 pushed:>${active}`,
    `topic:model-serving stars:>500 pushed:>${active}`,
    `topic:cuda stars:>1500 pushed:>${active}`,
    `topic:quantization stars:>800 pushed:>${active}`,
  ];

  // Unauthenticated search allows ~10 requests per minute, and this job issues
  // eight. Firing them back to back reliably trips a 403 halfway through, which
  // silently thins the digest. Space them out instead of paying for a token.
  const GAP_MS = process.env.GITHUB_TOKEN ? 0 : 2_000;

  const runAll = async (queries: string[], sort: string): Promise<Repo[]> => {
    const out: Repo[] = [];
    for (const [index, q] of queries.entries()) {
      if (index > 0 && GAP_MS > 0) await sleep(GAP_MS);
      try {
        out.push(...(await search(q, 20, sort)));
      } catch (error) {
        // One failed query must not empty the digest.
        console.error(`query skipped: ${q} (${String(error)})`);
      }
    }
    return out;
  };

  const fresh = (await runAll(freshQueries, "stars")).filter(isRelevant);
  const ecosystem = (await runAll(ecoQueries, "stars")).filter(isRelevant);

  fresh.sort((a, b) => starsPerDay(b) - starsPerDay(a));
  ecosystem.sort((a, b) => b.stargazers_count - a.stargazers_count);
  return { fresh, ecosystem };
}

async function main(): Promise<number> {
  loadEnv();
  const dryRun = process.argv.includes("--dry-run");
  if (process.argv.includes("--reset-seen")) {
    saveSeen(new Map());
    console.log("seen list cleared");
  }

  const pools = await collect();
  const seen = loadSeen();
  // selectRepos only cares about which names are excluded, not when they were sent.
  const seenNames = new Set(seen.keys());
  const selection = selectRepos(pools, seenNames);
  const message = formatDigest(selection);

  if (dryRun) {
    console.log(message);
    console.log(
      `\n[dry-run] fresh=${selection.fresh.length} eco=${selection.ecosystem.length} seen=${seen.size}`,
    );
    return 0;
  }

  const chatId = process.env.DIGEST_CHAT_ID?.trim();
  if (!chatId) throw new Error("DIGEST_CHAT_ID is not set");

  const { appId, appSecret } = readConfig();
  const messenger = new FeishuMessenger(new lark.Client({ appId, appSecret }));
  const ids = await messenger.sendText(chatId, message);
  console.log(`sent parts=${ids.length} ids=${ids.join(",")}`);

  const now = Date.now();
  for (const repo of [...selection.fresh, ...selection.ecosystem]) {
    seen.set(repo.full_name, now);
  }
  saveSeen(seen);
  console.log(`seen=${seen.size}`);
  return 0;
}

process.env.TZ = process.env.TZ ?? "Asia/Shanghai";

/**
 * Only run when executed directly. Without this guard, importing the module from
 * a test fires real GitHub queries as a side effect -- which is both slow and a
 * rate-limit hazard.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error("digest failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
