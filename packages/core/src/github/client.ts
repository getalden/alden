import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { GITHUB_SCOPES } from "./device-flow.js";

const AldenOctokit = Octokit.plugin(retry, throttling);
export type GitHubClient = InstanceType<typeof AldenOctokit>;

/** An Octokit client that retries server errors and backs off on rate limits (up to 2 retries each). */
export function createGitHubClient(token: string, userAgent = "alden"): GitHubClient {
  return new AldenOctokit({
    auth: token,
    userAgent,
    throttle: {
      onRateLimit: (_retryAfter, _options, _octokit, retryCount) => retryCount < 2,
      onSecondaryRateLimit: (_retryAfter, _options, _octokit, retryCount) => retryCount < 2,
    },
  });
}

export interface Viewer {
  login: string;
  name: string | null;
  /** Scopes on a classic OAuth token. Empty for fine-grained tokens, which don't report scopes. */
  scopes: string[];
  missingScopes: string[];
}

export async function getViewer(client: GitHubClient): Promise<Viewer> {
  const res = await client.request("GET /user");
  const header = res.headers["x-oauth-scopes"];
  const scopes = header
    ? header
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  // `admin:org` and `write:org` include `read:org`.
  const has = (scope: string) =>
    scopes.includes(scope) || (scope === "read:org" && scopes.some((s) => s === "admin:org" || s === "write:org"));
  const missingScopes = header === undefined ? [] : GITHUB_SCOPES.filter((s) => !has(s));
  return { login: res.data.login, name: res.data.name, scopes, missingScopes };
}
