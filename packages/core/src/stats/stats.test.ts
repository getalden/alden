import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { distribution, measure, type StatsPullRequest, summarizeStats, weekOf } from "./stats.js";
import { UsageLog } from "./usage.js";

const person = (login: string) => ({ login, __typename: "User" });
const bot = { login: "dependabot", __typename: "Bot" };

function pr(
  number: number,
  opts: Partial<StatsPullRequest> & { reviewsAt?: [string, string, string][] } = {},
): StatsPullRequest {
  return {
    number,
    createdAt: "2026-09-01T10:00:00Z",
    state: "MERGED",
    isDraft: false,
    author: person("sam"),
    readyEvents: [],
    reviews: (opts.reviewsAt ?? []).map(([login, state, at]) => ({ author: person(login), state, submittedAt: at })),
    ...opts,
  };
}

describe("measure", () => {
  it("starts the clock when a draft is marked ready, and ignores the author's own and pre-ready reviews", () => {
    const m = measure(
      pr(1, {
        readyEvents: [{ createdAt: "2026-09-01T12:00:00Z" }],
        reviewsAt: [
          ["kim", "COMMENTED", "2026-09-01T11:00:00Z"], // on the draft
          ["sam", "COMMENTED", "2026-09-01T13:00:00Z"], // the author
          ["kim", "CHANGES_REQUESTED", "2026-09-01T15:00:00Z"],
          ["lee", "APPROVED", "2026-09-02T12:00:00Z"],
        ],
      }),
    );
    expect(m.readyAt.toISOString()).toBe("2026-09-01T12:00:00.000Z");
    expect([m.firstReviewHours, m.approvalHours]).toEqual([3, 24]);
  });

  it("has no review time for a PR merged without one, and spots bots and drafts", () => {
    expect(measure(pr(2)).firstReviewHours).toBeNull();
    expect(measure(pr(3, { author: bot })).bot).toBe(true);
    expect(measure(pr(4, { state: "OPEN", isDraft: true })).draft).toBe(true);
  });

  it("counts an open PR's wait so far, and ignores approval time on an abandoned one", () => {
    const now = new Date("2026-09-03T10:00:00Z");
    const waiting = measure(pr(5, { state: "OPEN" }), now);
    expect([waiting.firstReviewHours, waiting.approvalHours, waiting.waitingForReview]).toEqual([48, 48, true]);
    const abandoned = measure(
      pr(6, { state: "CLOSED", reviewsAt: [["kim", "APPROVED", "2026-09-01T12:00:00Z"]] }),
      now,
    );
    expect([abandoned.firstReviewHours, abandoned.approvalHours]).toEqual([2, null]);
  });
});

describe("distribution", () => {
  it("gives the median and the nearest-rank 90th percentile", () => {
    expect(distribution([5, 1, 3])).toEqual({ count: 3, medianHours: 3, p90Hours: 5 });
    expect(distribution([1, 2, 3, 4])).toMatchObject({ medianHours: 2.5, p90Hours: 4 });
    expect(distribution([])).toEqual({ count: 0, medianHours: null, p90Hours: null });
  });
});

describe("summarizeStats", () => {
  it("splits before and after, groups by week, and leaves bots and unreviewed PRs out", () => {
    const stats = summarizeStats({
      repo: "acme/api",
      from: new Date("2026-07-01T00:00:00Z"),
      to: new Date("2026-10-01T00:00:00Z"),
      split: { at: "2026-09-10T00:00:00Z", source: "first-use" },
      truncated: false,
      prs: [
        pr(1, { createdAt: "2026-09-01T10:00:00Z", reviewsAt: [["kim", "APPROVED", "2026-09-02T10:00:00Z"]] }),
        pr(2, { createdAt: "2026-09-02T10:00:00Z", reviewsAt: [["kim", "COMMENTED", "2026-09-02T22:00:00Z"]] }),
        pr(3, { createdAt: "2026-09-15T10:00:00Z", reviewsAt: [["lee", "APPROVED", "2026-09-15T12:00:00Z"]] }),
        pr(4, { createdAt: "2026-09-16T10:00:00Z" }),
        pr(5, {
          createdAt: "2026-09-16T10:00:00Z",
          author: bot,
          reviewsAt: [["kim", "APPROVED", "2026-09-16T11:00:00Z"]],
        }),
        pr(6, { createdAt: "2026-09-17T10:00:00Z", state: "OPEN", isDraft: true }),
        pr(7, { createdAt: "2026-09-29T10:00:00Z", state: "OPEN" }),
      ],
      now: new Date("2026-09-30T10:00:00Z"),
    });
    // #7 was ready a day ago, inside the 14-day horizon, so it isn't judged yet.
    expect(stats.timeToFirstReview).toEqual({
      all: { count: 3, medianHours: 12, p90Hours: 24 },
      before: { count: 2, medianHours: 18, p90Hours: 24 },
      after: { count: 1, medianHours: 2, p90Hours: 2 },
    });
    expect(stats.cycleTime.before).toEqual({ count: 1, medianHours: 24, p90Hours: 24 });
    expect(stats.excluded).toEqual({ bots: 1, drafts: 1, tooRecent: 1, noReview: 1, noApproval: 2 });
    expect(stats.stillWaiting).toEqual({ review: 0, approval: 0 });
    expect(stats.horizonHours).toBe(336);
    expect(stats.weeks.map((w) => [w.week, w.prs])).toEqual([
      ["2026-08-31", 2],
      ["2026-09-14", 2],
    ]);
    expect(stats.prs).toBe(7);
  });

  it("has no before and after without a split", () => {
    const stats = summarizeStats({
      repo: "a/b",
      prs: [pr(1)],
      from: new Date(0),
      to: new Date(),
      split: null,
      truncated: true,
    });
    expect([stats.timeToFirstReview.before, stats.cycleTime.after, stats.truncated]).toEqual([null, null, true]);
  });
});

describe("the horizon", () => {
  it("caps every wait at it, so a PR still waiting counts as the full horizon on either side of the split", () => {
    const stats = summarizeStats({
      repo: "a/b",
      from: new Date("2026-08-01T00:00:00Z"),
      to: new Date("2026-09-30T00:00:00Z"),
      split: { at: "2026-09-01T00:00:00Z", source: "since" },
      truncated: false,
      horizonHours: 48,
      now: new Date("2026-09-30T00:00:00Z"),
      prs: [
        pr(1, { createdAt: "2026-08-10T00:00:00Z", reviewsAt: [["kim", "APPROVED", "2026-08-20T00:00:00Z"]] }),
        pr(2, { createdAt: "2026-09-10T00:00:00Z", state: "OPEN" }),
      ],
    });
    expect(stats.timeToFirstReview.before).toEqual({ count: 1, medianHours: 48, p90Hours: 48 });
    expect(stats.timeToFirstReview.after).toEqual({ count: 1, medianHours: 48, p90Hours: 48 });
    expect(stats.stillWaiting).toEqual({ review: 1, approval: 1 });
  });
});

describe("weekOf", () => {
  it("is the Monday the week starts", () => {
    expect(
      ["2026-09-28T09:00:00Z", "2026-10-04T23:00:00Z", "2026-10-05T00:00:00Z"].map((d) => weekOf(new Date(d))),
    ).toEqual(["2026-09-28", "2026-09-28", "2026-10-05"]);
  });
});

describe("UsageLog", () => {
  let dir: string;
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the first use of each repo, case-insensitively", async () => {
    dir = await mkdtemp(join(tmpdir(), "alden-usage-"));
    const usage = new UsageLog(join(dir, "usage.json"));
    await usage.markUsed("Acme/API", new Date("2026-09-10T00:00:00Z"));
    await usage.markUsed("acme/api", new Date("2026-09-20T00:00:00Z"));
    expect((await usage.firstUse("acme/api"))?.toISOString()).toBe("2026-09-10T00:00:00.000Z");
    expect(await usage.firstUse("acme/web")).toBeUndefined();
  });
});
