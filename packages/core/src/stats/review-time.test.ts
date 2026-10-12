import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelemetryEventSchema } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitHubClient } from "../github/client.js";
import { recordSeen } from "../learn/seen.js";
import { keepAldenDrafts } from "../review/auto-drafts.js";
import { ReviewDrafts, sendReview } from "../review/drafts.js";
import { AldenStore, MIGRATION_COUNT } from "../store/db.js";
import { activeBucket, reviewTimedEvent, wallBucket } from "../telemetry/events.js";
import {
  addActiveTime,
  closeReviewSession,
  dropReviewSession,
  MAX_ACTIVE_REPORT_MS,
  noteDrafted,
  noteKept,
  noteModelUsed,
  openReviewSession,
  REVIEW_TIME_KEEP_DAYS,
  reviewTimeStats,
  SESSION_STALE_DAYS,
  TERMINAL_ACTIVE_CAP_MS,
} from "./review-time.js";

const PR = "Acme/Shop#7";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-10-01T09:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms);

let home: string;
let store: AldenStore;
const savedHome = process.env.ALDEN_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "alden-review-time-"));
  process.env.ALDEN_HOME = home;
  store = AldenStore.open(join(home, "alden.db"));
});
afterEach(() => {
  store.close();
  if (savedHome === undefined) delete process.env.ALDEN_HOME;
  else process.env.ALDEN_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const sessions = () => store.all<Record<string, unknown>>("SELECT * FROM review_sessions ORDER BY opened_at");

describe("a review session", () => {
  it("is a new table, added by migration 9", () => {
    expect(MIGRATION_COUNT).toBeGreaterThanOrEqual(9);
    expect(store.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(MIGRATION_COUNT);
    expect(sessions()).toEqual([]);
  });

  it("starts when the briefing is first opened, and later opens continue it", () => {
    const id = openReviewSession(store, { pr: PR, surface: "ui" }, at(0));
    expect(openReviewSession(store, { pr: "acme/shop#7", surface: "cli", model: true }, at(10 * MIN))).toBe(id);
    expect(sessions()).toMatchObject([
      {
        pr_key: "acme/shop#7",
        surface: "ui",
        opened_at: at(0).toISOString(),
        terminal_opened_at: at(10 * MIN).toISOString(),
        ui: 1,
        model: 1,
        sent_at: null,
      },
    ]);
  });

  it("in the UI, counts the active time reported, and ends at send with what happened in it", () => {
    openReviewSession(store, { pr: PR, surface: "desktop" }, at(0));
    expect(addActiveTime(store, PR, 4 * MIN, at(5 * MIN))).toBe(true);
    expect(addActiveTime(store, PR, 3 * MIN, at(40 * MIN))).toBe(true);
    // One report never adds more than five minutes, and nothing silly counts.
    expect(addActiveTime(store, PR, 60 * MIN, at(41 * MIN))).toBe(true);
    expect(addActiveTime(store, PR, -1, at(41 * MIN))).toBe(false);
    expect(addActiveTime(store, PR, Number.NaN, at(41 * MIN))).toBe(false);
    noteDrafted(store, PR, "you", at(6 * MIN));
    noteDrafted(store, PR, "alden", at(6 * MIN));
    noteDrafted(store, PR, "alden", at(6 * MIN));
    noteKept(store, PR, 1, at(7 * MIN));
    noteModelUsed(store, PR, at(8 * MIN));
    recordSeen(store, { pr: "acme/shop#7", headSha: "h1", path: "a.ts", line: 3, how: "guided" }, at(9 * MIN));
    recordSeen(store, { pr: "acme/shop#7", headSha: "h2", path: "a.ts", line: 3, how: "diff" }, at(19 * MIN));
    recordSeen(store, { pr: "acme/shop#7", headSha: "h2", path: "b.ts", how: "diff" }, at(20 * MIN));

    const timing = closeReviewSession(store, { pr: PR, verdict: "APPROVE", comments: 2 }, at(2 * HOUR));
    expect(timing).toEqual({
      activeMs: 7 * MIN + MAX_ACTIVE_REPORT_MS,
      measured: true,
      wallMs: 2 * HOUR,
      placesSeen: 2,
      drafted: 3,
      draftedByAlden: 2,
      kept: 1,
      comments: 2,
      model: true,
      verdict: "APPROVE",
    });
    // Ended: nothing more counts, and the next open is a new session (a re-review).
    expect(addActiveTime(store, PR, MIN, at(3 * HOUR))).toBe(false);
    expect(closeReviewSession(store, { pr: PR, verdict: "COMMENT", comments: 0 }, at(3 * HOUR))).toBeUndefined();
    openReviewSession(store, { pr: PR, surface: "ui" }, at(4 * HOUR));
    expect(sessions()).toHaveLength(2);
  });

  it("from a terminal, estimates active time from the latest briefing to send, capped", () => {
    openReviewSession(store, { pr: PR, surface: "cli" }, at(0));
    openReviewSession(store, { pr: PR, surface: "mcp" }, at(3 * HOUR));
    const quick = closeReviewSession(store, { pr: PR, verdict: "COMMENT", comments: 1 }, at(3 * HOUR + 12 * MIN));
    expect(quick).toMatchObject({ activeMs: 12 * MIN, measured: false, wallMs: 3 * HOUR + 12 * MIN });

    openReviewSession(store, { pr: PR, surface: "cli" }, at(DAY));
    const slow = closeReviewSession(store, { pr: PR, verdict: "COMMENT", comments: 1 }, at(DAY + 5 * HOUR));
    expect(slow).toMatchObject({ activeMs: TERMINAL_ACTIVE_CAP_MS, measured: false });
  });

  it("uses the UI's measurement when the UI took part, even if the review began in a terminal", () => {
    openReviewSession(store, { pr: PR, surface: "cli" }, at(0));
    addActiveTime(store, PR, 2 * MIN, at(MIN));
    expect(closeReviewSession(store, { pr: PR, verdict: "COMMENT", comments: 0 }, at(HOUR))).toMatchObject({
      activeMs: 2 * MIN,
      measured: true,
    });
  });

  it("counts nothing before the briefing is opened", () => {
    expect(addActiveTime(store, PR, MIN)).toBe(false);
    noteDrafted(store, PR, "you");
    noteKept(store, PR, 2);
    noteModelUsed(store, PR);
    expect(sessions()).toEqual([]);
  });

  it("treats one left unsent too long as abandoned, and forgets old ones", () => {
    openReviewSession(store, { pr: PR, surface: "ui" }, at(0));
    const later = at((SESSION_STALE_DAYS + 1) * DAY);
    expect(addActiveTime(store, PR, MIN, later)).toBe(false);
    openReviewSession(store, { pr: PR, surface: "ui" }, later);
    expect(sessions()).toHaveLength(2);
    openReviewSession(store, { pr: "acme/shop#8", surface: "ui" }, at((REVIEW_TIME_KEEP_DAYS + 1) * DAY));
    expect(sessions().map((s) => s.pr_key)).toEqual(["acme/shop#7", "acme/shop#8"]);
  });

  it("drops the session under way when timing is turned off", () => {
    openReviewSession(store, { pr: PR, surface: "ui" }, at(0));
    dropReviewSession(store, PR, at(MIN));
    expect(sessions()).toEqual([]);
  });
});

describe("drafting and sending count toward the session", () => {
  /** A fake GitHub that takes one review. Nothing reaches GitHub. */
  const github = () =>
    ({
      request: async (route: string) => {
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return { data: { head: { sha: "h1" } } };
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") return { data: [] };
        if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
          return { data: { id: 9, html_url: "https://github.com/acme/shop/pull/7#pullrequestreview-9" } };
        }
        throw new Error(`unexpected ${route}`);
      },
    }) as unknown as GitHubClient;

  it("counts drafts and kept ones, and sendReview ends the session with its timing", async () => {
    openReviewSession(store, { pr: PR, surface: "ui" }, new Date(Date.now() - 30 * MIN));
    const drafts = new ReviewDrafts(store);
    drafts.add({ pr: "acme/shop#7", headSha: "h1", body: "Nice.", source: "you" });
    const alden = drafts.add({ pr: "acme/shop#7", headSha: "h1", body: "Fees?", source: "alden" });
    drafts.add({ pr: "acme/shop#7", headSha: "h1", body: "Dropped later.", source: "alden" });
    await keepAldenDrafts({ ids: [alden.id] }, { store, learn: false });
    addActiveTime(store, PR, 4 * MIN);

    const sent = await sendReview(github(), store, { repo: "acme/shop", number: 7, event: "APPROVE" });
    expect(sent.timing).toMatchObject({
      activeMs: 4 * MIN,
      measured: true,
      drafted: 3,
      draftedByAlden: 2,
      kept: 1,
      comments: 2,
      model: false,
      verdict: "APPROVE",
    });
    expect(sent.timing?.wallMs).toBeGreaterThanOrEqual(30 * MIN);
    expect(sessions()[0]).toMatchObject({ verdict: "APPROVE", sent_comments: 2, active_ms: 4 * MIN });
  });

  it("with stats.reviewTime off, sendReview drops the session instead", async () => {
    openReviewSession(store, { pr: PR, surface: "ui" });
    new ReviewDrafts(store).add({ pr: "acme/shop#7", headSha: "h1", body: "Nice.", source: "you" });
    const sent = await sendReview(github(), store, { repo: "acme/shop", number: 7, event: "COMMENT" }, new Date(), {
      reviewTime: false,
    });
    expect(sent.timing).toBeUndefined();
    expect(sessions()).toEqual([]);
  });

  it("without a session, sends as before with no timing", async () => {
    new ReviewDrafts(store).add({ pr: "acme/shop#7", headSha: "h1", body: "Nice.", source: "you" });
    const sent = await sendReview(github(), store, { repo: "acme/shop", number: 7, event: "COMMENT" });
    expect(sent.posted).toBe(1);
    expect(sent.timing).toBeUndefined();
  });
});

describe("time to review", () => {
  const NOW = new Date(T0 + 100 * DAY);
  /** A session opened `daysAgo`, sent after `wall` (or never) with `active` time. */
  const review = (daysAgo: number, wall: number | null, active: number, options: { model?: boolean } = {}) => {
    const opened = new Date(NOW.getTime() - daysAgo * DAY);
    const pr = `acme/shop#${sessions().length + 1}`;
    openReviewSession(store, { pr, surface: "ui", model: options.model ?? false }, opened);
    if (active > 0) addActiveTime(store, pr, active, opened);
    if (wall !== null) {
      closeReviewSession(store, { pr, verdict: "COMMENT", comments: 1 }, new Date(opened.getTime() + wall));
    }
  };

  it("groups by the day the briefing was opened, judging only reviews old enough, capped at the horizon", () => {
    review(5, 20 * MIN, 4 * MIN, { model: true });
    review(6, 2 * HOUR, 2 * MIN, { model: true });
    review(7, 10 * DAY, 3 * MIN, { model: true }); // sent long after: counts as the horizon
    review(10, 30 * MIN, 1 * MIN);
    review(20, 40 * MIN, 5 * MIN);
    review(60, 50 * MIN, 5 * MIN);
    review(1, 5 * MIN, 1 * MIN); // sent, but too recent: quick ones aren't counted before slow ones could be
    review(2, null, 0); // still open, too recent
    review(8, null, 0); // never sent

    const stats = reviewTimeStats(store, { now: NOW });
    expect(stats).toMatchObject({ schemaVersion: 1, enabled: true, horizonHours: 72 });
    const [d14, d30, d90] = stats.windows;
    expect(d14).toMatchObject({
      days: 14,
      all: { count: 4 },
      withModel: { count: 3, activeMedianMinutes: 3, wallMedianMinutes: 120, estimated: 0, small: true },
      withoutModel: { count: 1, activeMedianMinutes: 1, wallMedianMinutes: 30, small: true },
      excluded: { tooRecent: 2, notSent: 1 },
    });
    expect(d30?.withoutModel).toMatchObject({ count: 2, activeMedianMinutes: 3, wallMedianMinutes: 35 });
    expect(d90?.withoutModel.count).toBe(3);
  });

  it("caps open to send at the horizon: sent after 10 days counts as 3 days or more", () => {
    review(7, 10 * DAY, 3 * MIN);
    expect(reviewTimeStats(store, { now: NOW }).windows[0]?.all).toMatchObject({
      count: 1,
      wallMedianMinutes: 72 * 60,
    });
  });

  it("says when a group is big enough, and counts the terminal's estimates", () => {
    for (let i = 0; i < 10; i++) review(5 + i, 30 * MIN, 0);
    const [d14, d30] = reviewTimeStats(store, { now: NOW, enabled: false }).windows;
    expect(d14?.withoutModel).toMatchObject({ count: 10, small: false, estimated: 0 });
    expect(d30?.withModel).toMatchObject({ count: 0, activeMedianMinutes: null, small: true });
    const cli = "acme/api#1";
    openReviewSession(store, { pr: cli, surface: "cli" }, new Date(NOW.getTime() - 4 * DAY));
    closeReviewSession(store, { pr: cli, verdict: "APPROVE", comments: 0 }, new Date(NOW.getTime() - 4 * DAY + MIN));
    const after = reviewTimeStats(store, { now: NOW }).windows[0];
    expect(after?.all).toMatchObject({ count: 11, estimated: 1 });
  });
});

describe("the review_timed event", () => {
  it("buckets times coarsely", () => {
    expect([0, 1.9, 2, 7, 19, 25, 45, 61, 600].map((m) => activeBucket(m * MIN))).toEqual([
      "0-2",
      "0-2",
      "2-5",
      "5-10",
      "10-20",
      "20-30",
      "30-60",
      "60+",
      "60+",
    ]);
    expect([5, 30, 90, 5 * 60, 30 * 60, 5 * 24 * 60].map((m) => wallBucket(m * MIN))).toEqual([
      "0-15m",
      "15-60m",
      "1-4h",
      "4-24h",
      "1-3d",
      "3d+",
    ]);
  });

  it("carries buckets and counts only, and matches the telemetry schema", () => {
    const properties = reviewTimedEvent({
      activeMs: 7 * MIN,
      measured: true,
      wallMs: 3 * HOUR,
      placesSeen: 2,
      drafted: 4,
      draftedByAlden: 2,
      kept: 1,
      comments: 3,
      model: true,
      verdict: "REQUEST_CHANGES",
    });
    expect(properties).toEqual({
      active_minutes: "5-10",
      wall_time: "1-4h",
      measured: true,
      places_seen: 2,
      comments: 3,
      model: true,
      verdict: "request_changes",
    });
    expect(TelemetryEventSchema.safeParse({ event: "review_timed", properties }).success).toBe(true);
  });
});
