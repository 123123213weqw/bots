/**
 * Concrete dialogue flows.
 *
 * The first one is deliberately a real flow rather than a toy: "查仓库" needs a
 * second message (owner/repo), fetches live metadata, and can be cancelled. That
 * is the smallest thing that genuinely requires state -- one message cannot do
 * it, and a model guessing repository stats is exactly the kind of fabrication
 * the digest work was designed to avoid.
 */
import type { MachineDef } from "./machine.ts";

export interface RepoInfo {
  fullName: string;
  stars: number;
  language: string | null;
  license: string | null;
  description: string | null;
  pushedAt: string;
  url: string;
}

/**
 * Raised when the lookup could not be performed at all. Distinct from `null`,
 * which means the repository genuinely does not exist -- conflating the two
 * makes the bot assert something false.
 */
export class RepoQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoQueryError";
  }
}

/** Injected so the flow can be tested without the network. */
export interface RepoFetcher {
  fetch(fullName: string): Promise<RepoInfo | null>;
}

const TRIGGER = /^(\/repo|查仓库|查仓库信息|lookup)$/i;
/** owner/name, GitHub's own grammar: letters, digits, dash, dot, underscore. */
const REPO_PATTERN =
  /^([A-Za-z0-9](?:[A-Za-z0-9._-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99}))$/;

export function formatRepo(info: RepoInfo): string {
  const license =
    !info.license || info.license === "NOASSERTION" ? "license 不明确" : info.license;
  const lines = [
    info.fullName,
    info.description?.replace(/\s+/g, " ").trim() || "(无描述)",
    `${info.stars}★ · ${info.language ?? "—"} · ${license} · 更新于 ${info.pushedAt.slice(0, 10)}`,
    info.url,
  ];
  return lines.join("\n");
}

export function repoLookupFlow(fetcher: RepoFetcher): MachineDef {
  return {
    initial: "idle",
    defaultTtlMs: 3 * 60_000,
    cancel: /^(取消|退出|算了|\/cancel|cancel)$/i,
    onUnmatched: "请发送形如 owner/repo 的仓库名，或发「取消」退出。",
    states: {
      idle: {},
      await_repo: { prompt: "请发送仓库名，格式 owner/repo（例如 vllm-project/vllm）。" },
    },
    transitions: [
      // Entry: available from any idle state.
      {
        from: "*",
        match: TRIGGER,
        to: "await_repo",
      },
      // Slot filling. A bare word that is not owner/repo stays in this state and
      // gets the hint from onUnmatched rather than being sent to the model.
      {
        from: ["await_repo"],
        match: REPO_PATTERN,
        to: "idle",
        capture: { key: "repo" },
        action: async (ctx) => {
          const name = ctx.data["repo"] ?? "";
          try {
            const info = await fetcher.fetch(name);
            // Not found is a normal outcome, not an error: report and close.
            return info ? formatRepo(info) : `没找到 ${name}，确认一下拼写？`;
          } catch {
            // "I could not check" is a different sentence from "it is not there".
            return `查询 ${name} 时网络出问题了，稍后再试。`;
          }
        },
      },
    ],
  };
}
