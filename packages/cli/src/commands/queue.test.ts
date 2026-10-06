import type { RankedPullRequest, RankedQueue } from "@alden/schema";
import { describe, expect, it } from "vitest";
import { narrowQueue } from "./queue.js";

const row = (number: number, pr: Partial<RankedPullRequest["pr"]> = {}): RankedPullRequest => ({
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
    headRef: "feature",
    additions: 10,
    deletions: 0,
    changedFiles: 1,
    files: [],
    filesTruncated: false,
    labels: [],
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
});

const ranked: RankedQueue = {
  schemaVersion: 1,
  viewer: "me",
  fetchedAt: "2026-10-06T10:00:00Z",
  needsYou: [
    row(1, { additions: 400, labels: ["db"] }),
    row(2, { author: "dependabot[bot]", authorIsBot: true }),
    row(3, { title: "Fix login", labels: ["db"] }),
  ],
  fastTrack: [],
  warnings: [],
};

describe("alden queue --author --label --search --sort", () => {
  it("leaves the queue alone without them", () => {
    expect(narrowQueue(ranked, {}, Date.now())).toEqual({ queue: ranked, note: undefined });
  });

  it("narrows, re-sorts within each group, and says so", () => {
    const { queue, note } = narrowQueue(ranked, { label: "db", sort: "size" }, Date.now());
    expect(queue.needsYou.map((r) => r.pr.number)).toEqual([3, 1]);
    expect(note).toBe("2 of 3 PRs: label db; sorted by size, smallest first within each group.");
    expect(narrowQueue(ranked, { author: "bots" }, Date.now()).queue.needsYou.map((r) => r.pr.number)).toEqual([2]);
    expect(narrowQueue(ranked, { search: "login" }, Date.now()).note).toBe('1 of 3 PRs: matching "login".');
    expect(narrowQueue(ranked, { sort: "waiting" }, Date.now()).note).toBe(
      "Sorted by waiting on you, longest first within each group.",
    );
  });
});
