import type { RepoStats, ReviewTimeGroup, ReviewTimeStats } from "@alden/schema";
import { describe, expect, it } from "vitest";
import { change, formatHours, formatMinutes, renderReviewTime, renderStats, sparkline } from "./stats.js";

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

  it("says when comparing can start if nothing after the split is old enough yet", () => {
    const text = renderStats(
      { ...stats, timeToFirstReview: { ...stats.timeToFirstReview, after: dist(0, null, null) } },
      false,
    );
    expect(text).toContain("Too soon to compare: PRs ready from 1 Sep can be judged from 15 Sep");
    expect(text).toMatch(/Time to first review\s+20h median/);
  });

  it("explains how to get a before and after when there's no split", () => {
    expect(renderStats({ ...stats, split: null }, false)).toContain("Pass --since YYYY-MM-DD");
  });
});

const group = (count: number, active: number | null, wall: number | null, estimated = 0): ReviewTimeGroup => ({
  count,
  activeMedianMinutes: active,
  wallMedianMinutes: wall,
  estimated,
  small: count < 10,
});
const timeWindow = (days: number, withModel: ReviewTimeGroup, withoutModel: ReviewTimeGroup) => ({
  days,
  from: "2026-09-01T00:00:00.000Z",
  to: "2026-10-01T00:00:00.000Z",
  all: group(withModel.count + withoutModel.count, null, null, withModel.estimated + withoutModel.estimated),
  withModel,
  withoutModel,
  excluded: { tooRecent: 2, notSent: 3 },
});
const timed: ReviewTimeStats = {
  schemaVersion: 1,
  generatedAt: "2026-10-01T00:00:00.000Z",
  enabled: true,
  horizonHours: 72,
  windows: [
    timeWindow(14, group(4, 12, 130), group(0, null, null)),
    timeWindow(30, group(8, 11.6, 95, 1), group(3, 9, 4320)),
    timeWindow(90, group(14, 10, 80, 2), group(12, 7.5, 50)),
  ],
};

describe("alden stats: time to review", () => {
  it("formats minutes, with the horizon as a floor", () => {
    expect([0.5, 12.4, 65, 130, 3000, 4320, null].map((m) => formatMinutes(m, 4320))).toEqual([
      "30s",
      "12m",
      "1h 5m",
      "2h 10m",
      "2d 2h",
      "3d+",
      "–",
    ]);
  });

  it("shows the two medians side by side per window, with sample sizes, and says when they're few", () => {
    const text = renderReviewTime(timed, false);
    expect(text).toContain("Time to review · your reviews sent with Alden, by the day you first opened the briefing");
    expect(text).toMatch(/Last 14 days\n\s+With the model\s+12m\s+2h 10m\s+4 \(few\)\n\s+Without\s+–\s+–\s+0/);
    expect(text).toMatch(
      /Last 30 days\n\s+With the model\s+12m\s+1h 35m\s+8 \(few\)\n\s+Without\s+9m\s+3d\+\s+3 \(few\)/,
    );
    expect(text).toMatch(/Last 90 days\n\s+With the model\s+10m\s+1h 20m\s+14\n/);
    expect(text).toContain("(few): under 10 reviews, too few to read much into");
    expect(text).toContain("Not counted: 2 opened in the last 3 days");
    expect(text).toContain("3 opened and never sent from Alden");
    expect(text).toContain("2 reviews' active time is the terminal's estimate");
    expect(text).not.toMatch(/faster|slower/);
  });

  it("says what's missing when nothing is timed yet, or when it's off", () => {
    const empty = {
      ...timed,
      enabled: false,
      windows: timed.windows.map((w) => ({
        ...w,
        all: group(0, null, null),
        withModel: group(0, null, null),
        withoutModel: group(0, null, null),
        excluded: { tooRecent: 0, notSent: 0 },
      })),
    };
    const text = renderReviewTime(empty, false);
    expect(text).toContain("Off: Alden isn't recording how long reviews take.");
    expect(text).toContain("No reviews timed yet");
    const waiting = {
      ...empty,
      enabled: true,
      windows: empty.windows.map((w) => ({ ...w, excluded: { tooRecent: 1, notSent: 0 } })),
    };
    expect(renderReviewTime(waiting, false)).toContain(
      "Nothing to show yet: 1 review opened in the last 3 days counts once it's 3 days old.",
    );
  });
});
