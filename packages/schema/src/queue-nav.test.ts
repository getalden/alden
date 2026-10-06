import { describe, expect, it } from "vitest";
import type { RankedPullRequest, RankedQueue } from "./queue.js";
import { navigateQueue, parseQueueNav, type QueueNav, queueFacets, queueFilter, sortLane } from "./queue-nav.js";

const NOW = Date.parse("2026-10-06T15:00:00");

function row(number: number, pr: Partial<RankedPullRequest["pr"]> = {}, extra: Partial<RankedPullRequest> = {}) {
  return {
    pr: {
      repo: "acme/api",
      number,
      title: `PR ${number}`,
      url: `https://github.com/acme/api/pull/${number}`,
      author: "sam",
      authorIsBot: false,
      isDraft: false,
      createdAt: "2026-09-01T10:00:00Z",
      updatedAt: "2026-09-01T10:00:00Z",
      baseRef: "main",
      headRef: `feature-${number}`,
      additions: 10,
      deletions: 0,
      changedFiles: 1,
      files: [],
      filesTruncated: false,
      labels: [],
      assignees: [],
      ci: "success",
      mergeable: "mergeable",
      reviews: [],
      request: { direct: true, teams: [], requestedAt: null },
      codeownedFiles: [],
      stackedPrs: 0,
      ...pr,
    },
    lane: "needs-you",
    score: { risk: 1, wait: 1, blocking: 0, total: 2 },
    reasons: [],
    waitingHours: 10,
    waitingOnAuthor: false,
    ...extra,
  } satisfies RankedPullRequest;
}

const queue: RankedQueue = {
  schemaVersion: 1,
  viewer: "me",
  fetchedAt: "2026-10-06T14:00:00Z",
  needsYou: [
    row(1, { title: "Charge in cents", labels: ["billing"], createdAt: "2026-10-06T09:00:00", additions: 300 }),
    row(2, { author: "dependabot", authorIsBot: true, headRef: "dependabot/npm/zod", ci: "failure" }),
    row(3, { author: "me", assignees: ["me"], request: { direct: false, teams: ["acme/web"], requestedAt: null } }),
    row(
      4,
      { author: "Copilot", authorIsBot: true, isDraft: true, createdAt: "2026-10-02T10:00:00Z" },
      { waitingHours: 90 },
    ),
    row(5, { author: "kim", headRef: "claude/fix-login", assignees: ["kim"], ci: "none", repo: "acme/web" }),
  ],
  fastTrack: [
    row(6, { additions: 1, title: "Docs typo", updatedAt: "2026-10-05T10:00:00Z" }, { lane: "fast-track" }),
    row(7, { additions: 5, labels: ["Billing"] }, { lane: "fast-track" }),
  ],
  dismissed: [row(8, { author: "dependabot", authorIsBot: true })],
  warnings: [],
};

const numbers = (nav: Partial<QueueNav> & { search?: string }) => {
  const view = navigateQueue(
    queue,
    { filters: nav.filters ?? {}, sort: nav.sort ?? "rank" },
    {
      now: NOW,
      search: nav.search ?? "",
    },
  );
  return [...view.needsYou, ...view.fastTrack].map((r) => r.pr.number);
};

describe("narrowing the queue", () => {
  it("searches title, repo, #number, author and branches; every word must match", () => {
    expect(numbers({ search: "cents" })).toEqual([1]);
    expect(numbers({ search: "#3" })).toEqual([3]);
    expect(numbers({ search: "3" })).toEqual([3]);
    expect(numbers({ search: "acme/web" })).toEqual([5]);
    expect(numbers({ search: "@kim" })).toEqual([5]);
    expect(numbers({ search: "npm/zod" })).toEqual([2]);
    expect(numbers({ search: "DOCS typo" })).toEqual([6]);
    expect(numbers({ search: "docs cents" })).toEqual([]);
    expect(numbers({ search: "  " })).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("filters by author kind, reusing learning's classification, or by login", () => {
    expect(numbers({ filters: { author: "bots" } })).toEqual([2]);
    // Copilot's app, and a person's PR from Claude's branch, are agents.
    expect(numbers({ filters: { author: "agents" } })).toEqual([4, 5]);
    expect(numbers({ filters: { author: "you" } })).toEqual([3]);
    expect(numbers({ filters: { author: "people" } })).toEqual([1, 6, 7]);
    expect(numbers({ filters: { author: "@Dependabot" } })).toEqual([2]);
  });

  it("filters by how you were asked, assignee, label, drafts, CI and age", () => {
    expect(numbers({ filters: { reviewer: "direct" } })).toEqual([1, 2, 4, 5, 6, 7]);
    expect(numbers({ filters: { reviewer: "teams" } })).toEqual([3]);
    expect(numbers({ filters: { reviewer: "acme/web" } })).toEqual([3]);
    expect(numbers({ filters: { assignee: "you" } })).toEqual([3]);
    expect(numbers({ filters: { assignee: "kim" } })).toEqual([5]);
    expect(numbers({ filters: { assignee: "none" } })).toEqual([1, 2, 4, 6, 7]);
    expect(numbers({ filters: { label: "billing" } })).toEqual([1, 7]);
    expect(numbers({ filters: { drafts: "hide" } })).toEqual([1, 2, 3, 5, 6, 7]);
    expect(numbers({ filters: { drafts: "only" } })).toEqual([4]);
    expect(numbers({ filters: { ci: "failing" } })).toEqual([2]);
    expect(numbers({ filters: { ci: "none" } })).toEqual([5]);
    expect(numbers({ filters: { age: "today" } })).toEqual([1]);
    expect(numbers({ filters: { age: "week" } })).toEqual([1, 4]);
    expect(numbers({ filters: { age: "older" } })).toEqual([2, 3, 5, 6, 7]);
  });

  it("combines filters with AND, and counts what's shown of the whole", () => {
    const view = navigateQueue(
      queue,
      { filters: { label: "billing", repo: "acme/api" }, sort: "rank" },
      { now: NOW, search: "cents" },
    );
    expect(view.needsYou.map((r) => r.pr.number)).toEqual([1]);
    expect([view.shown, view.total]).toEqual([1, 7]);
    // Dismissed PRs are filtered too, and stay apart.
    expect(navigateQueue(queue, { filters: { author: "bots" }, sort: "rank" }, { now: NOW }).dismissed).toHaveLength(1);
  });

  it("sorts inside each lane, keeping Alden's order for ties and its rank for each row", () => {
    expect(numbers({ sort: "size" })).toEqual([2, 3, 4, 5, 1, 6, 7]);
    expect(numbers({ sort: "waiting" })).toEqual([4, 1, 2, 3, 5, 6, 7]);
    expect(numbers({ sort: "age" })).toEqual([2, 3, 5, 4, 1, 6, 7]);
    expect(numbers({ sort: "updated" }).slice(-2)).toEqual([6, 7]);
    const view = navigateQueue(queue, { filters: {}, sort: "waiting" }, { now: NOW });
    expect(view.rank.get("acme/api#4")).toBe(4);
    expect(sortLane(queue.needsYou, "rank")).toBe(queue.needsYou);
  });

  it("lists what the menus can offer, dismissed PRs included", () => {
    expect(queueFacets(queue)).toEqual({
      repos: ["acme/api", "acme/web"],
      labels: ["billing", "Billing"],
      assignees: ["kim", "me"],
      teams: ["acme/web"],
      hasDrafts: true,
    });
  });

  it("reads a remembered view field by field, dropping anything it doesn't know", () => {
    expect(parseQueueNav({ filters: { author: "bots", ci: "green", age: "week", label: 3 }, sort: "size" })).toEqual({
      filters: { author: "bots", age: "week" },
      sort: "size",
    });
    expect(parseQueueNav("nonsense")).toEqual({ filters: {}, sort: "rank" });
    expect(parseQueueNav({ sort: "random" })).toEqual({ filters: {}, sort: "rank" });
  });

  it("stays quick for a thousand PRs", () => {
    const big: RankedQueue = {
      ...queue,
      needsYou: Array.from({ length: 1000 }, (_, i) => row(i + 1, { title: `Change ${i}`, additions: (i * 37) % 500 })),
    };
    const keep = queueFilter({ author: "people", drafts: "hide" }, { viewer: "me", now: NOW, search: "change 9" });
    const start = performance.now();
    for (let i = 0; i < 20; i++) {
      big.needsYou.filter(keep);
      navigateQueue(big, { filters: { ci: "passing" }, sort: "size" }, { now: NOW, search: "change" });
    }
    expect((performance.now() - start) / 20).toBeLessThan(25);
  });
});
