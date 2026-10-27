/** Live GitHub repository lookup for the "查仓库" flow. */
import type { RepoFetcher, RepoInfo } from "./flows.ts";
import { RepoQueryError } from "./flows.ts";

export class GitHubRepos implements RepoFetcher {
  #token: string | undefined;
  #timeoutMs: number;

  constructor(options: { token?: string; timeoutMs?: number } = {}) {
    this.#token = options.token?.trim() || undefined;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async fetch(fullName: string): Promise<RepoInfo | null> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "bots-query",
    };
    if (this.#token) headers["authorization"] = `Bearer ${this.#token}`;

    let response: Response;
    try {
      response = await fetch(`https://api.github.com/repos/${fullName}`, {
        headers,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      // Transport failure must NOT be reported as "repository not found": that
      // is a false statement about the world. Only a real 404 means that.
      const reason = error instanceof Error ? error.message : String(error);
      throw new RepoQueryError(`network: ${reason}`);
    }
    // 404 is a legitimate answer (typo, private, deleted).
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new RepoQueryError(`github http ${response.status}`);
    }

    const body = (await response.json()) as Record<string, unknown>;
    return {
      fullName: String(body["full_name"] ?? fullName),
      stars: Number(body["stargazers_count"] ?? 0),
      language: (body["language"] as string | null) ?? null,
      license: ((body["license"] as { spdx_id?: string } | null)?.spdx_id) ?? null,
      description: (body["description"] as string | null) ?? null,
      pushedAt: String(body["pushed_at"] ?? ""),
      url: String(body["html_url"] ?? ""),
    };
  }
}

export function reposFromEnv(env: NodeJS.ProcessEnv = process.env): GitHubRepos {
  return new GitHubRepos({ token: env.GITHUB_TOKEN });
}
