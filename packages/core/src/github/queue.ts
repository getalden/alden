import type { JsonCache } from "../cache.js";
import type { GitHubClient } from "./client.js";
import { CODEOWNERS_PATHS, type CodeownersRule, parseCodeowners } from "./codeowners.js";
import {
  PULL_REQUEST_FIELDS,
  type PullRequestFacts,
  type RawPullRequest,
  toFacts,
  type Viewer,
} from "./pull-requests.js";

const PAGE_SIZE = 25;

export interface ReviewQueue {
  viewer: string;
  fetchedAt: string;
  pullRequests: PullRequestFacts[];
  /** Things the user should know, e.g. team requests are invisible without `read:org`. */
  warnings: string[];
}

export async function fetchViewer(client: GitHubClient): Promise<{ viewer: Viewer; warnings: string[] }> {
  const { data: user } = await client.request("GET /user");
  const teams = new Set<string>();
  const warnings: string[] = [];
  try {
    for (let page = 1; ; page++) {
      const { data } = await client.request("GET /user/teams", { per_page: 100, page });
      for (const team of data) teams.add(`${team.organization.login}/${team.slug}`.toLowerCase());
      if (data.length < 100) break;
    }
  } catch {
    warnings.push(
      "Couldn't list your teams (the token may lack read:org), so team review requests look like direct ones.",
    );
  }
  return { viewer: { login: user.login, teams }, warnings };
}

const SEARCH_QUERY = `
  query($q: String!, $first: Int!, $after: String) {
    search(query: $q, type: ISSUE, first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ... on PullRequest { ${PULL_REQUEST_FIELDS} } }
    }
  }
`;

interface SearchResult {
  search: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawPullRequest[] };
}

/** Runs a GitHub issue search for PRs and returns up to `limit` raw PR nodes. */
/** Up to `limit` PRs; `more` when GitHub has others past it. */
export async function searchPullRequests(
  client: GitHubClient,
  q: string,
  limit: number,
): Promise<RawPullRequest[] & { more?: boolean }> {
  const results: RawPullRequest[] & { more?: boolean } = [];
  let after: string | null = null;
  while (results.length < limit) {
    const page: SearchResult = await client.graphql<SearchResult>(SEARCH_QUERY, {
      q,
      first: Math.min(PAGE_SIZE, limit - results.length),
      after,
    });
    results.push(...page.search.nodes.filter((n) => n && "number" in n));
    results.more = page.search.pageInfo.hasNextPage;
    if (!page.search.pageInfo.hasNextPage) break;
    after = page.search.pageInfo.endCursor;
  }
  return results;
}

/** Reads CODEOWNERS from a branch, checking the same locations GitHub does. Empty if there is none. */
export async function fetchCodeowners(client: GitHubClient, repo: string, ref: string): Promise<CodeownersRule[]> {
  const [owner, name] = repo.split("/");
  const fields = CODEOWNERS_PATHS.map(
    (path, i) => `f${i}: object(expression: ${JSON.stringify(`${ref}:${path}`)}) { ... on Blob { text } }`,
  );
  const data = await client.graphql<{ repository: Record<string, { text?: string } | null> | null }>(
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(" ")} } }`,
    { owner, name },
  );
  const repository = data.repository ?? {};
  for (let i = 0; i < CODEOWNERS_PATHS.length; i++) {
    const text = repository[`f${i}`]?.text;
    if (text) return parseCodeowners(text);
  }
  return [];
}

/**
 * Counts open PRs built on top of each PR (based on its branch), in one batched query.
 * PRs from forks are skipped: their branch lives in the fork, so a same-named branch upstream is unrelated.
 */
export async function fetchStackedCounts(client: GitHubClient, prs: RawPullRequest[]): Promise<number[]> {
  const counts = prs.map(() => 0);
  const fields = prs.flatMap((pr, i) => {
    if (pr.isCrossRepository) return [];
    const [owner, name] = pr.repository.nameWithOwner.split("/");
    return [
      `p${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
        pullRequests(baseRefName: ${JSON.stringify(pr.headRefName)}, states: OPEN) { totalCount }
      }`,
    ];
  });
  if (fields.length === 0) return counts;

  const data = await client.graphql<Record<string, { pullRequests: { totalCount: number } } | null>>(
    `query { ${fields.join("\n")} }`,
  );
  for (const [key, value] of Object.entries(data)) {
    counts[Number(key.slice(1))] = value?.pullRequests.totalCount ?? 0;
  }
  return counts;
}

export interface QueueOptions {
  includeDrafts?: boolean;
  limit?: number;
  cache?: JsonCache;
  /** How long a cached queue stays fresh. Defaults to 60 seconds. */
  maxAgeMs?: number;
  /** Skip the cached queue, but still store the new one. */
  refresh?: boolean;
  /** Only these repos (`owner/name`). Combined with `orgs`, a PR matching either is included. */
  repos?: string[];
  /** Only repos owned by these users or organisations. */
  orgs?: string[];
}

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
const OWNER_NAME = /^[\w-]+$/;

/** The GitHub search query for the viewer's queue. Throws on a malformed repo or org name. */
export function queueSearchQuery(options: Pick<QueueOptions, "includeDrafts" | "repos" | "orgs"> = {}): string {
  const parts = ["is:pr", "is:open", "archived:false", "review-requested:@me"];
  if (!options.includeDrafts) parts.push("draft:false");
  for (const repo of options.repos ?? []) {
    if (!REPO_NAME.test(repo)) throw new Error(`"${repo}" isn't a repo name. Use owner/name, e.g. getalden/alden.`);
    parts.push(`repo:${repo}`);
  }
  for (const org of options.orgs ?? []) {
    if (!OWNER_NAME.test(org)) throw new Error(`"${org}" isn't a GitHub user or organisation name.`);
    parts.push(`org:${org}`);
  }
  return parts.join(" ");
}

/** Every open PR waiting on the viewer's review, directly or through a team, with the facts ranking needs. */
export async function fetchReviewQueue(client: GitHubClient, options: QueueOptions = {}): Promise<ReviewQueue> {
  const { limit = 100, cache, maxAgeMs = 60_000, refresh = false } = options;
  const q = queueSearchQuery(options);
  const { viewer, warnings } = await fetchViewer(client);

  const cacheKey = `queue:v3:${viewer.login}:${limit}:${q}`;
  const cached = refresh ? undefined : await cache?.get<ReviewQueue>(cacheKey, maxAgeMs);
  if (cached) return cached;

  const raw = await searchPullRequests(client, q, limit);
  if (raw.more) {
    warnings.push(
      `More than ${limit} PRs are waiting on you; Alden ranked the ${limit} GitHub returned first. Narrow it with --repo or --org, or raise --limit.`,
    );
  }

  // One CODEOWNERS lookup per repo and base branch.
  const codeowners = new Map<string, Promise<CodeownersRule[]>>();
  for (const pr of raw) {
    const key = `${pr.repository.nameWithOwner}@${pr.baseRefName}`;
    if (!codeowners.has(key)) {
      codeowners.set(
        key,
        fetchCodeowners(client, pr.repository.nameWithOwner, pr.baseRefName).catch(() => []),
      );
    }
  }

  const stacked = await fetchStackedCounts(client, raw).catch(() => raw.map(() => 0));
  const pullRequests = await Promise.all(
    raw.map(async (pr, i) => ({
      ...toFacts(pr, viewer, await (codeowners.get(`${pr.repository.nameWithOwner}@${pr.baseRefName}`) ?? [])),
      stackedPrs: stacked[i] ?? 0,
    })),
  );

  const queue: ReviewQueue = { viewer: viewer.login, fetchedAt: new Date().toISOString(), pullRequests, warnings };
  await cache?.set(cacheKey, queue);
  return queue;
}
