import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonCache } from "../cache.js";
import type { GitHubClient } from "./client.js";
import type { RawPullRequest } from "./pull-requests.js";
import { cachedReviewQueue, fetchReviewQueue, QUEUE_KEEP_MS, queueDebugEnabled, queueSearchQuery } from "./queue.js";

const FIXTURE = join(import.meta.dirname, "__fixtures__", "grafana.json");

interface Calls {
  searches: { q: string; first: number; after: string | null }[];
  details: string[][];
  codeowners: number;
  manifests: string[];
  stackQueries: string[];
}

type Fixture = RawPullRequest & { id?: string; baseRefOid?: string; headRefOid?: string };

/**
 * A stand-in GitHub client serving recorded PRs: a search that pages through their ids and branches, their details by
 * id, a CODEOWNERS file for every repo, `stacked` open PRs on top of every PR's branch, and manifests from `blobs`
 * (keyed "oid:path").
 */
function fakeClient(
  fixtures: Fixture[],
  options: { teamsForbidden?: boolean; stacked?: number; blobs?: Record<string, string> } = {},
) {
  const prs = fixtures.map((pr, i) => ({
    ...pr,
    id: pr.id ?? `PR_${i}`,
    baseRefOid: pr.baseRefOid ?? `base-${pr.repository.nameWithOwner}`,
    headRefOid: pr.headRefOid ?? `head-${i}`,
  }));
  const calls: Calls = { searches: [], details: [], codeowners: 0, manifests: [], stackQueries: [] };
  const client = {
    auth: async () => ({ type: "token", token: "test-token" }),
    request: async (route: string) => {
      if (route === "GET /user") return { data: { login: "nwrichmond" } };
      if (route === "GET /user/teams") {
        if (options.teamsForbidden) throw new Error("403");
        return { data: [{ slug: "frontend-ops", organization: { login: "grafana" } }] };
      }
      throw new Error(`unexpected ${route}`);
    },
    graphql: async (query: string, vars: Record<string, unknown>) => {
      if (query.includes("search(")) {
        const after = (vars.after as string | null) ?? null;
        calls.searches.push({ q: vars.q as string, first: vars.first as number, after });
        const start = after ? Number(after) : 0;
        const end = start + (vars.first as number);
        return {
          search: {
            nodes: prs.slice(start, end).map(({ id, number, repository, baseRefName, headRefName, ...rest }) => ({
              id,
              number,
              repository,
              baseRefName,
              headRefName,
              isCrossRepository: rest.isCrossRepository,
              baseRefOid: rest.baseRefOid,
              headRefOid: rest.headRefOid,
            })),
            pageInfo: { hasNextPage: end < prs.length, endCursor: String(end) },
          },
        };
      }
      if (query.includes("nodes(ids")) {
        const ids = vars.ids as string[];
        calls.details.push(ids);
        return { nodes: ids.map((id) => prs.find((p) => p.id === id) ?? null) };
      }
      if (query.includes("pullRequests(baseRefName")) {
        calls.stackQueries.push(query);
        const aliases = [...query.matchAll(/\b(p\d+): repository/g)].map((m) => m[1] as string);
        return Object.fromEntries(aliases.map((a) => [a, { pullRequests: { totalCount: options.stacked ?? 0 } }]));
      }
      if (query.includes("CODEOWNERS")) {
        calls.codeowners++;
        return { repository: { f0: { text: "* @grafana/frontend-ops\n" } } };
      }
      calls.manifests.push(query);
      const blobs = [...query.matchAll(/(\w+): object\(expression: "([^"]+)"\)/g)];
      return {
        repository: Object.fromEntries(
          blobs.map(([, alias, expr]) => [alias, { text: options.blobs?.[expr as string] }]),
        ),
      };
    },
  };
  return { client: client as unknown as GitHubClient, calls };
}

let prs: RawPullRequest[];
let cacheDir: string;

beforeEach(async () => {
  prs = (JSON.parse(await readFile(FIXTURE, "utf8")) as { pullRequests: RawPullRequest[] }).pullRequests;
  cacheDir = await mkdtemp(join(tmpdir(), "alden-queue-"));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe("fetchReviewQueue", () => {
  it("searches for open, non-draft PRs requesting the viewer's review", async () => {
    const { client, calls } = fakeClient(prs);
    await fetchReviewQueue(client);
    expect(calls.searches[0]?.q).toBe("is:pr is:open archived:false review-requested:@me draft:false");

    const withDrafts = fakeClient(prs);
    await fetchReviewQueue(withDrafts.client, { includeDrafts: true });
    expect(withDrafts.calls.searches[0]?.q).not.toContain("draft:false");
  });

  it("pages through results up to the limit", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...structuredClone(prs[0] as RawPullRequest),
      number: i + 1,
    }));
    const { client, calls } = fakeClient(many);
    const queue = await fetchReviewQueue(client, { limit: 28 });
    expect(queue.pullRequests).toHaveLength(28);
    expect(calls.searches.map((s) => s.first)).toEqual([28]);
    // The details come in batches of 25, fetched side by side.
    expect(calls.details.map((ids) => ids.length)).toEqual([25, 3]);
    // More were waiting than the limit: the queue says so instead of dropping them quietly.
    expect(queue.warnings.join(" ")).toContain("More than 28 PRs are waiting on you");
    const all = await fetchReviewQueue(fakeClient(many).client, { limit: 30 });
    expect(all.warnings.join(" ")).not.toContain("More than");
  });

  it("pages the search 100 PRs at a time, keeping GitHub's order", async () => {
    const many = Array.from({ length: 146 }, (_, i) => ({
      ...structuredClone(prs[0] as RawPullRequest),
      number: i + 1,
    }));
    const { client, calls } = fakeClient(many);
    const queue = await fetchReviewQueue(client, { limit: 1000 });
    expect(calls.searches.map((s) => s.first)).toEqual([100, 100]);
    expect(calls.details).toHaveLength(6);
    expect(queue.pullRequests.map((p) => p.number)).toEqual(many.map((p) => p.number));
  });

  it("reads CODEOWNERS once per repo and base commit, and applies the viewer's teams", async () => {
    const { client, calls } = fakeClient(prs);
    const queue = await fetchReviewQueue(client);
    expect(calls.codeowners).toBe(new Set(prs.map((p) => p.repository.nameWithOwner)).size);
    expect(queue.viewer).toBe("nwrichmond");
    expect(queue.pullRequests.every((p) => p.codeownedFiles.length === p.files.length)).toBe(true);
    expect(queue.warnings).toEqual([]);
  });

  it("warns, rather than fails, when the viewer's teams can't be listed", async () => {
    const { client } = fakeClient(prs, { teamsForbidden: true });
    const queue = await fetchReviewQueue(client);
    expect(queue.pullRequests).toHaveLength(prs.length);
    expect(queue.warnings[0]).toMatch(/read:org/);
  });

  it("serves a fresh cached queue without searching again", async () => {
    const cache = new JsonCache(cacheDir);
    const first = fakeClient(prs);
    await fetchReviewQueue(first.client, { cache });
    const second = fakeClient(prs);
    const queue = await fetchReviewQueue(second.client, { cache });
    expect(second.calls.searches).toHaveLength(0);
    expect(queue.pullRequests).toHaveLength(prs.length);

    const refreshed = fakeClient(prs);
    await fetchReviewQueue(refreshed.client, { cache, refresh: true });
    expect(refreshed.calls.searches).toHaveLength(1);
  });

  it("remembers CODEOWNERS by base commit, so a refresh doesn't read it again", async () => {
    const cache = new JsonCache(cacheDir);
    await fetchReviewQueue(fakeClient(prs).client, { cache });
    const again = fakeClient(prs);
    await fetchReviewQueue(again.client, { cache, refresh: true });
    expect(again.calls.codeowners).toBe(0);
    const moved = fakeClient(prs.map((p) => ({ ...p, baseRefOid: "new-base" })));
    await fetchReviewQueue(moved.client, { cache, refresh: true });
    expect(moved.calls.codeowners).toBe(1);
  });

  it("keeps a queue for a day for callers that would rather show an old one than wait", async () => {
    let now = Date.parse("2026-10-04T09:00:00Z");
    const cache = new JsonCache(cacheDir, () => now);
    await fetchReviewQueue(fakeClient(prs).client, { cache });
    now += 3 * 60_000;
    const fresh = fakeClient(prs);
    await fetchReviewQueue(fresh.client, { cache });
    expect(fresh.calls.searches).toHaveLength(1);
    const stale = fakeClient(prs);
    const queue = await fetchReviewQueue(stale.client, { cache, maxAgeMs: QUEUE_KEEP_MS });
    // Read without a single request: the cache is keyed by the account, not a login GitHub has to supply.
    expect(stale.calls).toMatchObject({ searches: [], details: [], codeowners: 0 });
    expect(queue.pullRequests).toHaveLength(prs.length);
    expect((await cachedReviewQueue(stale.client, { cache }))?.fetchedAt).toBe(queue.fetchedAt);
    // Another scope, or a day gone by: nothing to show.
    expect(await cachedReviewQueue(stale.client, { cache, repos: ["grafana/other"] })).toBeUndefined();
    now += 25 * 3_600_000;
    expect(await cachedReviewQueue(stale.client, { cache })).toBeUndefined();
  });

  it("reads only changed manifests, at the base and head commits, for major bumps", async () => {
    const bump = {
      ...structuredClone(prs[0] as RawPullRequest),
      number: 77,
      headRefOid: "abc",
      baseRefOid: "def",
      files: {
        nodes: [
          { path: "composer.json", additions: 1, deletions: 1 },
          { path: "src/Date.php", additions: 3, deletions: 1 },
        ],
        pageInfo: { hasNextPage: false },
      },
    };
    const blobs = {
      "def:composer.json": JSON.stringify({ require: { "nesbot/carbon": "^3.8" } }),
      "abc:composer.json": JSON.stringify({ require: { "nesbot/carbon": "^4.0" } }),
    };
    const cache = new JsonCache(cacheDir);
    const { client, calls } = fakeClient([...prs, bump], { blobs });
    const queue = await fetchReviewQueue(client, { cache });
    expect(calls.manifests).toHaveLength(1);
    expect(calls.manifests[0]).not.toContain("Date.php");
    expect(queue.pullRequests.find((p) => p.number === 77)?.majorBumps).toEqual([
      { name: "nesbot/carbon", from: "3", to: "4" },
    ]);
    expect(queue.pullRequests.filter((p) => p.majorBumps)).toHaveLength(1);

    // Same head commit: remembered.
    const again = fakeClient([...prs, bump], { blobs });
    await fetchReviewQueue(again.client, { cache, refresh: true });
    expect(again.calls.manifests).toHaveLength(0);
  });

  it("reports where the time went when asked", async () => {
    const reports: string[] = [];
    await fetchReviewQueue(fakeClient(prs).client, { onTiming: (r) => reports.push(r) });
    expect(reports[0]).toMatch(/^queue: \d+ PRs in \d+ms/);
    for (const step of ["viewer", "search", "details", "codeowners", "stacked"]) expect(reports[0]).toContain(step);
  });

  it("counts PRs stacked on each PR in one query, skipping PRs from forks", async () => {
    const mixed = prs.map((p, i) => ({ ...structuredClone(p), isCrossRepository: i === 0 }));
    const { client, calls } = fakeClient(mixed, { stacked: 2 });
    const queue = await fetchReviewQueue(client);
    expect(calls.stackQueries).toHaveLength(1);
    expect(queue.pullRequests.map((p) => p.stackedPrs)).toEqual(mixed.map((_, i) => (i === 0 ? 0 : 2)));
  });
});

describe("queueDebugEnabled", () => {
  it("turns on for ALDEN_DEBUG=queue, alone or in a list, and for 1 or *", () => {
    expect(queueDebugEnabled({ ALDEN_DEBUG: "queue" })).toBe(true);
    expect(queueDebugEnabled({ ALDEN_DEBUG: "review,queue" })).toBe(true);
    expect(queueDebugEnabled({ ALDEN_DEBUG: "1" })).toBe(true);
    expect(queueDebugEnabled({ ALDEN_DEBUG: "review" })).toBe(false);
    expect(queueDebugEnabled({})).toBe(false);
  });
});

describe("queueSearchQuery", () => {
  it("adds repo and org filters", () => {
    expect(queueSearchQuery({ repos: ["getalden/alden", "vercel/next.js"], orgs: ["laravel"] })).toBe(
      "is:pr is:open archived:false review-requested:@me draft:false repo:getalden/alden repo:vercel/next.js org:laravel",
    );
  });

  it("leaves out ignored orgs and repos", () => {
    expect(queueSearchQuery({ orgs: ["acme"], ignore: ["acme/legacy", "acme-labs"] })).toBe(
      "is:pr is:open archived:false review-requested:@me draft:false org:acme -repo:acme/legacy -org:acme-labs",
    );
    expect(() => queueSearchQuery({ ignore: ["a b"] })).toThrow(/queue.ignore/);
  });

  it("rejects names that would inject other search qualifiers", () => {
    expect(() => queueSearchQuery({ repos: ["getalden"] })).toThrow(/owner\/name/);
    expect(() => queueSearchQuery({ repos: ["a/b is:closed"] })).toThrow();
    expect(() => queueSearchQuery({ orgs: ["acme author:me"] })).toThrow(/organisation/);
  });
});
