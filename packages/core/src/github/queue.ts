import { createHash } from "node:crypto";
import type { AgentMarker } from "@alden/schema";
import type { JsonCache } from "../cache.js";
import { type MajorBump, majorBumps } from "../queue/bumps.js";
import { isManifest } from "../review/dependencies.js";
import { fetchAgentMarkers, needsMarkers } from "./agent-markers.js";
import type { GitHubClient } from "./client.js";
import { CODEOWNERS_PATHS, type CodeownersRule, parseCodeowners } from "./codeowners.js";
import { cachedOrgAccess, orgAccessWarnings, orgInScope } from "./orgs.js";
import {
  PULL_REQUEST_FIELDS,
  type PullRequestFacts,
  type RawPullRequest,
  toFacts,
  type Viewer,
} from "./pull-requests.js";

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

/** PRs per page of the queue search, which only asks for what's needed to fetch the rest. */
const SEARCH_PAGE_SIZE = 100;
/** PRs per detail request. Each brings files, reviews and timeline, so GitHub answers slowly past a few dozen. */
const DETAIL_BATCH = 25;
/** Requests in flight at once for details, and again for manifests: well under GitHub's secondary rate limits. */
const CONCURRENCY = 6;
/** CODEOWNERS at a commit and a PR's manifest bumps at its head commit never change. */
const IMMUTABLE_MS = 7 * 24 * 3_600_000;

/** What the queue search returns for each PR: enough to fetch its details, CODEOWNERS and stacked PRs at once. */
export interface PullRequestRef {
  id: string;
  number: number;
  repository: { nameWithOwner: string };
  baseRefName: string;
  headRefName: string;
  isCrossRepository: boolean;
  baseRefOid: string;
  headRefOid: string;
}

const SEARCH_QUERY = `
  query($q: String!, $first: Int!, $after: String) {
    search(query: $q, type: ISSUE, first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on PullRequest {
          id number repository { nameWithOwner } baseRefName headRefName isCrossRepository baseRefOid headRefOid
        }
      }
    }
  }
`;

interface SearchResult {
  search: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: PullRequestRef[] };
}

/** Up to `limit` PRs matching a GitHub issue search, in its order; `more` when GitHub has others past it. */
export async function searchPullRequestRefs(
  client: GitHubClient,
  q: string,
  limit: number,
): Promise<PullRequestRef[] & { more?: boolean; pages?: number }> {
  const results: PullRequestRef[] & { more?: boolean; pages?: number } = [];
  let after: string | null = null;
  results.pages = 0;
  while (results.length < limit) {
    const page: SearchResult = await client.graphql<SearchResult>(SEARCH_QUERY, {
      q,
      first: Math.min(SEARCH_PAGE_SIZE, limit - results.length),
      after,
    });
    results.pages++;
    results.push(...page.search.nodes.filter((n) => n && "number" in n));
    results.more = page.search.pageInfo.hasNextPage;
    if (!page.search.pageInfo.hasNextPage) break;
    after = page.search.pageInfo.endCursor;
  }
  return results;
}

const NODES_QUERY = `
  query($ids: [ID!]!) {
    nodes(ids: $ids) { ... on PullRequest { id ${PULL_REQUEST_FIELDS} } }
  }
`;

/** The full facts for PRs by node id, in the order asked. PRs GitHub no longer returns are left out. */
export async function fetchPullRequestNodes(
  client: GitHubClient,
  ids: string[],
): Promise<(RawPullRequest & { id: string })[]> {
  const data = await client.graphql<{ nodes: ((RawPullRequest & { id: string }) | null)[] }>(NODES_QUERY, { ids });
  return data.nodes.filter((n): n is RawPullRequest & { id: string } => n !== null && "number" in n);
}

/** Runs a GitHub issue search for PRs and returns up to `limit` raw PR nodes; `more` when GitHub has others. */
export async function searchPullRequests(
  client: GitHubClient,
  q: string,
  limit: number,
): Promise<RawPullRequest[] & { more?: boolean }> {
  const refs = await searchPullRequestRefs(client, q, limit);
  const batches = await mapLimit(chunk(refs, DETAIL_BATCH), CONCURRENCY, (batch) =>
    fetchPullRequestNodes(
      client,
      batch.map((r) => r.id),
    ),
  );
  return Object.assign(batches.flat(), { more: refs.more ?? false });
}

/** CODEOWNERS' text on a branch or commit, from the first of the places GitHub looks that has one. */
async function fetchCodeownersText(client: GitHubClient, repo: string, ref: string): Promise<string | undefined> {
  const [owner, name] = repo.split("/");
  const fields = CODEOWNERS_PATHS.map(
    (path, i) => `f${i}: object(expression: ${JSON.stringify(`${ref}:${path}`)}) { ... on Blob { text } }`,
  );
  const data = await client.graphql<{ repository: Record<string, { text?: string } | null> | null }>(
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(" ")} } }`,
    { owner, name },
  );
  const repository = data.repository ?? {};
  return CODEOWNERS_PATHS.map((_, i) => repository[`f${i}`]?.text).find((text) => text);
}

/** Reads CODEOWNERS from a branch, checking the same locations GitHub does. Empty if there is none. */
export async function fetchCodeowners(client: GitHubClient, repo: string, ref: string): Promise<CodeownersRule[]> {
  const text = await fetchCodeownersText(client, repo, ref);
  return text ? parseCodeowners(text) : [];
}

/** CODEOWNERS at a commit, remembered for a week: the same commit always has the same file. */
async function cachedCodeowners(
  client: GitHubClient,
  repo: string,
  oid: string,
  cache: JsonCache | undefined,
): Promise<{ rules: CodeownersRule[]; cached: boolean }> {
  const key = `codeowners:v1:${repo}@${oid}`;
  const hit = await cache?.get<{ text: string | null }>(key, IMMUTABLE_MS);
  if (hit) return { rules: hit.text ? parseCodeowners(hit.text) : [], cached: true };
  const text = (await fetchCodeownersText(client, repo, oid)) ?? null;
  await cache?.set(key, { text });
  return { rules: text ? parseCodeowners(text) : [], cached: false };
}

/**
 * Counts open PRs built on top of each PR (based on its branch), in one batched query.
 * PRs from forks are skipped: their branch lives in the fork, so a same-named branch upstream is unrelated.
 */
export async function fetchStackedCounts(
  client: GitHubClient,
  prs: Pick<RawPullRequest, "isCrossRepository" | "repository" | "headRefName">[],
): Promise<number[]> {
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

/**
 * The major version bumps in a PR's changed manifests, from just those files at the base branch's tip and the PR's
 * head: one small request, remembered by head commit. Undefined when the PR changes no manifest Alden reads.
 */
export async function fetchMajorBumps(
  client: GitHubClient,
  ref: PullRequestRef,
  paths: string[],
  cache?: JsonCache,
): Promise<{ bumps: MajorBump[]; cached: boolean } | undefined> {
  const manifests = paths.filter((path) => isManifest(path));
  if (manifests.length === 0 || !ref.baseRefOid || !ref.headRefOid) return undefined;
  const repo = ref.repository.nameWithOwner;
  const key = `major-bumps:v1:${repo}#${ref.number}@${ref.headRefOid}`;
  const hit = await cache?.get<MajorBump[]>(key, IMMUTABLE_MS);
  if (hit) return { bumps: hit, cached: true };

  const [owner, name] = repo.split("/");
  const blob = (alias: string, oid: string, path: string) =>
    `${alias}: object(expression: ${JSON.stringify(`${oid}:${path}`)}) { ... on Blob { text } }`;
  const fields = manifests.flatMap((path, i) => [
    blob(`b${i}`, ref.baseRefOid, path),
    blob(`h${i}`, ref.headRefOid, path),
  ]);
  const data = await client.graphql<{ repository: Record<string, { text?: string } | null> | null }>(
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(" ")} } }`,
    { owner, name },
  );
  const files = data.repository ?? {};
  const bumps = manifests.flatMap((path, i) => majorBumps(path, files[`b${i}`]?.text, files[`h${i}`]?.text));
  await cache?.set(key, bumps);
  return { bumps, cached: false };
}

/** Runs at most `limit` tasks at once; the rest wait their turn. */
function limiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** Splits a list into runs of `size`. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `Promise.all(items.map(fn))` with at most `limit` running at once, results in order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Where a fresh queue's time goes, one line per step, printed to stderr when `ALDEN_DEBUG` includes `queue`.
 * Steps overlap, so their times add up to more than the total.
 */
class QueueTiming {
  private readonly start = performance.now();
  private readonly steps = new Map<string, { from: number; to: number; calls: number; note?: string }>();

  async time<T>(step: string, work: Promise<T>): Promise<T> {
    const from = performance.now() - this.start;
    try {
      return await work;
    } finally {
      const to = performance.now() - this.start;
      const seen = this.steps.get(step);
      this.steps.set(step, {
        from: Math.min(seen?.from ?? from, from),
        to: Math.max(seen?.to ?? to, to),
        calls: (seen?.calls ?? 0) + 1,
        ...(seen?.note ? { note: seen.note } : {}),
      });
    }
  }

  note(step: string, note: string): void {
    const seen = this.steps.get(step);
    if (seen) seen.note = note;
    else this.steps.set(step, { from: 0, to: 0, calls: 0, note });
  }

  report(prs: number): string {
    const ms = (n: number) => `${Math.round(n)}ms`;
    const lines = [...this.steps].map(
      ([step, s]) =>
        `  ${step.padEnd(12)} ${ms(s.to - s.from).padStart(7)}  (${ms(s.from)} → ${ms(s.to)}, ${s.calls} request${s.calls === 1 ? "" : "s"}${s.note ? `, ${s.note}` : ""})`,
    );
    return [`queue: ${prs} PRs in ${ms(performance.now() - this.start)}`, ...lines].join("\n");
  }
}

/** True when `ALDEN_DEBUG` asks for the queue's timing (`queue`, `1`, `*` or `all`). */
export function queueDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ALDEN_DEBUG ?? "").split(/[\s,]+/).some((v) => ["queue", "1", "*", "all"].includes(v.toLowerCase()));
}

/** A stable, private name for the signed-in account, so the cache can be read before asking GitHub who it is. */
async function accountKey(client: GitHubClient): Promise<string> {
  try {
    const auth = (await client.auth()) as { token?: string };
    if (auth.token) return createHash("sha256").update(auth.token).digest("hex").slice(0, 16);
  } catch {
    // No token to name the account by: fall through.
  }
  return "anonymous";
}

export interface QueueOptions {
  includeDrafts?: boolean;
  limit?: number;
  cache?: JsonCache;
  /**
   * How old a cached queue may be and still be used. Defaults to 60 seconds; pass up to `QUEUE_KEEP_MS` to show the
   * last queue at once while a fresh one loads.
   */
  maxAgeMs?: number;
  /** Skip the cached queue, but still store the new one. */
  refresh?: boolean;
  /** Only these repos (`owner/name`). Combined with `orgs`, a PR matching either is included. */
  repos?: string[];
  /** Only repos owned by these users or organisations. */
  orgs?: string[];
  /** Organisations or repos (`owner/name`) to leave out. */
  ignore?: string[];
  /** Gets a breakdown of where a fresh queue's time went. Defaults to stderr when `ALDEN_DEBUG` includes `queue`. */
  onTiming?: (report: string) => void;
  /** Told what's happening as it goes, e.g. "Checking acme/shop (25 of 146 PRs)", for a spinner. */
  onProgress?: (step: string) => void;
}

/** How long a fresh queue counts as current. */
export const QUEUE_FRESH_MS = 60_000;
/** How long the last queue is kept to show while a fresh one loads. */
export const QUEUE_KEEP_MS = 24 * 3_600_000;

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
const OWNER_NAME = /^[\w-]+$/;

/** The GitHub search query for the viewer's queue. Throws on a malformed repo or org name. */
export function queueSearchQuery(
  options: Pick<QueueOptions, "includeDrafts" | "repos" | "orgs" | "ignore"> = {},
): string {
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
  for (const name of options.ignore ?? []) {
    if (REPO_NAME.test(name)) parts.push(`-repo:${name}`);
    else if (OWNER_NAME.test(name)) parts.push(`-org:${name}`);
    else throw new Error(`"${name}" in queue.ignore isn't an organisation or owner/name.`);
  }
  return parts.join(" ");
}

/** Keyed by the account, not its login, so a cached queue is read without a request. v5: facts carry assignees. */
async function queueCacheKey(client: GitHubClient, options: QueueOptions): Promise<string> {
  return `queue:v5:${await accountKey(client)}:${options.limit ?? 100}:${queueSearchQuery(options)}`;
}

/**
 * The last queue fetched with these options, if it's at most `maxAgeMs` old (default: kept a day), without asking
 * GitHub anything. For showing a queue at once while a fresh one loads; its `fetchedAt` says how old it is.
 */
export async function cachedReviewQueue(
  client: GitHubClient,
  options: QueueOptions & { cache: JsonCache },
  maxAgeMs: number = QUEUE_KEEP_MS,
): Promise<ReviewQueue | undefined> {
  return options.cache.get<ReviewQueue>(await queueCacheKey(client, options), maxAgeMs);
}

/**
 * Every open PR waiting on the viewer's review, directly or through a team, with the facts ranking needs.
 *
 * The search only returns each PR's id and branches, so everything else starts at once: the details in parallel
 * batches (each batch then reads its changed manifests for major bumps), CODEOWNERS per repo and base commit, and the
 * stacked-PR counts. Paging through the full facts one page at a time is what used to make a big queue slow.
 */
export async function fetchReviewQueue(client: GitHubClient, options: QueueOptions = {}): Promise<ReviewQueue> {
  const { limit = 100, cache, maxAgeMs = QUEUE_FRESH_MS, refresh = false, onProgress = () => {} } = options;
  const q = queueSearchQuery(options);
  const cacheKey = await queueCacheKey(client, options);
  const cached = refresh ? undefined : await cache?.get<ReviewQueue>(cacheKey, maxAgeMs);
  if (cached) return cached;

  const timing = new QueueTiming();
  onProgress("Finding the PRs waiting on you");
  const viewerReady = timing.time("viewer", fetchViewer(client));
  const refs = await timing.time("search", searchPullRequestRefs(client, q, limit));
  timing.note("search", `${refs.length} PRs`);
  // A failed viewer lookup fails the queue, as before; don't leave it unhandled while the rest runs.
  viewerReady.catch(() => {});

  // Orgs that hide their PRs from this sign-in make the queue look short without an error: say which.
  const orgAccess = viewerReady.then(({ viewer }) =>
    timing.time("org access", cachedOrgAccess(client, viewer.login, cache)).catch(() => []),
  );

  // One CODEOWNERS lookup per repo and base commit, remembered for a week.
  const codeowners = new Map<string, Promise<CodeownersRule[]>>();
  let codeownersCached = 0;
  const ownersKey = (ref: PullRequestRef) => `${ref.repository.nameWithOwner}@${ref.baseRefOid || ref.baseRefName}`;
  for (const ref of refs) {
    const key = ownersKey(ref);
    if (codeowners.has(key)) continue;
    const repo = ref.repository.nameWithOwner;
    const lookup = ref.baseRefOid
      ? cachedCodeowners(client, repo, ref.baseRefOid, cache).then(({ rules, cached }) => {
          if (cached) codeownersCached++;
          return rules;
        })
      : fetchCodeowners(client, repo, ref.baseRefName);
    codeowners.set(
      key,
      timing.time("codeowners", lookup).catch(() => []),
    );
  }

  const stacked = timing.time("stacked", fetchStackedCounts(client, refs)).catch(() => refs.map(() => 0));

  // Details in parallel batches. Each batch's PRs that change a manifest then have it read for major bumps, in the
  // background with their own limit, so the next batch of details isn't kept waiting.
  const bumps = new Map<string, MajorBump[]>();
  let bumpsCached = 0;
  const manifestSlot = limiter(CONCURRENCY);
  const manifestReads: Promise<void>[] = [];
  const markers = new Map<string, AgentMarker>();
  const markerReads: Promise<void>[] = [];
  let markersCached = 0;
  // Progress names the repo of the first PR whose details are still loading.
  const loaded = new Set<string>();
  const reportDetails = () => {
    const next = refs.find((r) => !loaded.has(r.id));
    if (next) onProgress(`Checking ${next.repository.nameWithOwner} (${loaded.size} of ${refs.length} PRs)`);
  };
  if (refs.length > 0) reportDetails();
  const details = await mapLimit(chunk(refs, DETAIL_BATCH), CONCURRENCY, async (batch) => {
    const nodes = await timing.time(
      "details",
      fetchPullRequestNodes(
        client,
        batch.map((r) => r.id),
      ),
    );
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const ref of batch) loaded.add(ref.id);
    reportDetails();
    for (const ref of batch) {
      const pr = byId.get(ref.id);
      const paths = (pr?.files?.nodes ?? []).map((f) => f.path);
      // A cut-short file list may hide the manifest; and most PRs change none, which costs no request.
      if (!pr || pr.files?.pageInfo.hasNextPage || !paths.some((path) => isManifest(path))) continue;
      manifestReads.push(
        manifestSlot(() => timing.time("manifests", fetchMajorBumps(client, ref, paths, cache)))
          .then((found) => {
            if (found?.cached) bumpsCached++;
            if (found) bumps.set(ref.id, found.bumps);
          })
          .catch(() => {}),
      );
    }
    // A person's PR may be an AI agent's: read its description and last commit for an agent's marker. See agent-markers.ts.
    const unsure = batch.filter((ref) => {
      const pr = byId.get(ref.id);
      return pr !== undefined && needsMarkers(pr);
    });
    if (unsure.length > 0) {
      const targets = unsure.map((r) => ({
        id: r.id,
        repo: r.repository.nameWithOwner,
        number: r.number,
        headOid: r.headRefOid,
      }));
      markerReads.push(
        manifestSlot(() => timing.time("markers", fetchAgentMarkers(client, targets, cache)))
          .then((found) => {
            markersCached += found.cached;
            for (const [id, marker] of found.markers) markers.set(id, marker);
          })
          .catch(() => {}),
      );
    }
    return nodes;
  });
  if (manifestReads.length > 0) onProgress("Reading changed dependency manifests");
  await Promise.all([...manifestReads, ...markerReads]);
  const raw = new Map(details.flat().map((n) => [n.id, n]));

  const { viewer, warnings } = await viewerReady;
  warnings.push(...orgAccessWarnings((await orgAccess).filter((a) => orgInScope(a.org, options))));
  if (refs.more) {
    warnings.push(
      `More than ${limit} PRs are waiting on you; Alden ranked the ${limit} GitHub returned first. Narrow it with --repo or --org, or raise --limit.`,
    );
  }

  if (refs.length > 0) onProgress("Looking for PRs stacked on these");
  const counts = await stacked;
  const pullRequests: PullRequestFacts[] = [];
  for (const [i, ref] of refs.entries()) {
    const pr = raw.get(ref.id);
    if (!pr) continue;
    const found = bumps.get(ref.id);
    pullRequests.push({
      ...toFacts(pr, viewer, await (codeowners.get(ownersKey(ref)) ?? [])),
      stackedPrs: counts[i] ?? 0,
      ...(found?.length ? { majorBumps: found } : {}),
      ...(markers.has(ref.id) ? { agentMarker: markers.get(ref.id) } : {}),
    });
  }

  timing.note("codeowners", `${codeowners.size} repos, ${codeownersCached} from cache`);
  timing.note("manifests", `${bumpsCached} from cache`);
  timing.note("markers", `${markersCached} from cache`);
  const report = options.onTiming ?? (queueDebugEnabled() ? (r: string) => console.error(r) : undefined);
  report?.(timing.report(pullRequests.length));

  const queue: ReviewQueue = { viewer: viewer.login, fetchedAt: new Date().toISOString(), pullRequests, warnings };
  await cache?.set(cacheKey, queue);
  return queue;
}
