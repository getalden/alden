import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonCache } from "../cache.js";
import type { GitHubClient } from "./client.js";
import type { RawPullRequest } from "./pull-requests.js";
import { fetchReviewQueue } from "./queue.js";

const FIXTURE = join(import.meta.dirname, "__fixtures__", "grafana.json");

interface Calls {
  searches: { q: string; first: number; after: string | null }[];
  codeowners: number;
}

/** A stand-in GitHub client serving recorded PRs in pages, and a CODEOWNERS file for every repo. */
function fakeClient(prs: RawPullRequest[], options: { teamsForbidden?: boolean } = {}) {
  const calls: Calls = { searches: [], codeowners: 0 };
  const client = {
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
            nodes: prs.slice(start, end),
            pageInfo: { hasNextPage: end < prs.length, endCursor: String(end) },
          },
        };
      }
      calls.codeowners++;
      return { repository: { f0: { text: "* @grafana/frontend-ops\n" } } };
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
    expect(calls.searches.map((s) => s.first)).toEqual([25, 3]);
  });

  it("reads CODEOWNERS once per repo and branch, and applies the viewer's teams", async () => {
    const { client, calls } = fakeClient(prs);
    const queue = await fetchReviewQueue(client);
    expect(calls.codeowners).toBe(new Set(prs.map((p) => p.baseRefName)).size);
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
});
