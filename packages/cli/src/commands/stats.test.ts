import type { RepoStats } from "@alden/schema";
import { describe, expect, it } from "vitest";
import { change, formatHours, renderStats, sparkline } from "./stats.js";

const dist = (count: number, medianHours: number | null, p90Hours: number | null) => ({ count, medianHours, p90Hours });

const stats: RepoStats = {
  schemaVersion: 1,
  repo: "acme/api",
  fetchedAt: "2026-09-30T10:00:00.000Z",
  window: { from: "2026-07-02T10:00:00.000Z", to: "2026-09-30T10:00:00.000Z" },
  split: { at: "2026-09-01T00:00:00.000Z", source: "first-use" },
  prs: 40,
  horizonHours: 336,
  timeToFirstReview: { all: dist(30, 20, 336), before: dist(20, 30, 336), after: dist(10, 12, 100) },
  cycleTime: { all: dist(28, 60, 336), before: dist(19, 50, 336), after: dist(9, 110, 336) },
  weeks: [
    { week: "2026-08-24", prs: 5, timeToFirstReviewMedianHours: 336, cycleTimeMedianHours: 336 },
    { week: "2026-08-31", prs: 4, timeToFirstReviewMedianHours: null, cycleTimeMedianHours: null },
    { week: "2026-09-07", prs: 6, timeToFirstReviewMedianHours: 10, cycleTimeMedianHours: 40 },
  ],
  excluded: { bots: 3, drafts: 1, tooRecent: 6, noReview: 2, noApproval: 4 },
  stillWaiting: { review: 1, approval: 2 },
  truncated: false,
};

describe("alden stats rendering", () => {
  it("formats waits, with the horizon as a floor", () => {
    expect([0.5, 9.4, 40, 60, 336, 400, null].map((h) => formatHours(h, 336))).toEqual([
      "30m",
      "9h",
      "40h",
      "2d 12h",
      "14d+",
      "14d+",
      "–",
    ]);
  });

  it("says how the median moved", () => {
    expect(change(dist(1, 30, 0), dist(1, 12, 0))).toBe("60% faster");
    expect(change(dist(1, 50, 0), dist(1, 110, 0))).toBe("2.2× slower");
    expect(change(dist(1, 50, 0), dist(1, 51, 0))).toBe("no change");
    expect(change(dist(1, 50, 0), null)).toBeNull();
  });

  it("draws weekly medians against the horizon, with gaps for empty weeks", () => {
    expect(sparkline([336, null, 10, 0], 336)).toBe("█ ▁▁");
  });

  it("shows before, after and the change, then what was left out", () => {
    const text = renderStats(stats, false);
    expect(text).toContain("acme/api · PRs opened in the last 90 days · waits judged over 14 days");
    expect(text).toMatch(
      /Time to first review\s+30h median · 14d\+ p90 \(20\)\s+12h median · 4d 4h p90 \(10\)\s+60% faster/,
    );
    expect(text).toContain("Split at 1 Sep: your first review with Alden here.");
    expect(text).toContain("40 PRs opened: 6 too recent to judge, 1 still waiting for a review (counted as 14d+)");
  });

  it("explains how to get a before and after when there's no split", () => {
    expect(renderStats({ ...stats, split: null }, false)).toContain("Pass --since YYYY-MM-DD");
  });
});
