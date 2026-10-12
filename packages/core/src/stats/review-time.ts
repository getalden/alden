import { randomUUID } from "node:crypto";
import {
  REVIEW_TIME_SCHEMA_VERSION,
  REVIEW_TIME_SMALL_SAMPLE,
  REVIEW_TIME_WINDOWS,
  type ReviewEvent,
  type ReviewTimeGroup,
  type ReviewTimeStats,
  type TelemetryCommon,
} from "@alden/schema";
import type { AldenStore } from "../store/db.js";

/*
 * Time to review: how long your reviews take with Alden, recorded on this machine (`stats.reviewTime`, on by default).
 * A session starts when a PR's briefing is first opened, on any surface (the web UI, the desktop app, `alden review`,
 * an AI tool's `alden_review`), and ends when `sendReview` sends the review; reviewing the PR again later starts a new
 * one. Durations and counts only: never what the PR or your comments say. Usage stats (only if you opted in) get one
 * `review_timed` event per sent review, in coarse buckets: see `reviewTimedEvent`.
 */

/** Where a briefing was opened. */
export type ReviewSurface = TelemetryCommon["surface"];

/** In the UI, a stretch with no input longer than this isn't active time (the whole stretch, not just the excess). */
export const IDLE_MS = 2 * 60_000;
/**
 * A terminal or AI tool can't see whether you're looking, so without time measured in the UI a review's active time is
 * from its latest briefing there to the send, capped at this.
 */
export const TERMINAL_ACTIVE_CAP_MS = 30 * 60_000;
/** The most active time one report from the UI adds: it reports every few seconds, so anything more is a bug. */
export const MAX_ACTIVE_REPORT_MS = 5 * 60_000;
/** A session not sent after this long was abandoned (reviewed elsewhere, or not at all): the next open starts anew. */
export const SESSION_STALE_DAYS = 14;
/** How long sessions are kept: the longest window, and a horizon's worth more. */
export const REVIEW_TIME_KEEP_DAYS = 120;
/**
 * Reviews are judged only once their briefing was opened at least this long ago, and open-to-send is capped at it. As
 * `alden stats` does for PRs: grouping by open date, and waiting the same stretch for every review, keeps quick recent
 * reviews from crowding out slow ones that haven't been sent yet.
 */
export const REVIEW_TIME_HORIZON_HOURS = 72;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const keyOf = (pr: string) => pr.trim().toLowerCase();
const terminal = (surface: ReviewSurface) => surface === "cli" || surface === "mcp";

interface SessionRow {
  id: string;
  pr_key: string;
  surface: string;
  opened_at: string;
  terminal_opened_at: string | null;
  ui: number;
  active_ms: number;
  measured: number;
  model: number;
  drafted: number;
  drafted_by_alden: number;
  kept: number;
  places_seen: number | null;
  sent_comments: number | null;
  verdict: string | null;
  sent_at: string | null;
}

/** The PR's session under way: opened, not sent, and not abandoned. */
function openSession(store: AldenStore, pr: string, now: Date): SessionRow | undefined {
  return store.get<SessionRow>(
    "SELECT * FROM review_sessions WHERE pr_key = ? AND sent_at IS NULL AND opened_at >= ? ORDER BY opened_at DESC LIMIT 1",
    keyOf(pr),
    new Date(now.getTime() - SESSION_STALE_DAYS * DAY).toISOString(),
  );
}

/**
 * A PR's briefing was opened ("owner/repo#12"): starts its review session, or notes another open of the one under way
 * (from a terminal, the latest is where its active-time estimate starts). `model`: Alden's model briefed it. Not for
 * the desktop app's background briefings, which aren't you opening anything until you read one.
 */
export function openReviewSession(
  store: AldenStore,
  input: { pr: string; surface: ReviewSurface; model?: boolean },
  now: Date = new Date(),
): string {
  const at = now.toISOString();
  const existing = openSession(store, input.pr, now);
  const fromTerminal = terminal(input.surface);
  if (existing) {
    store.run(
      `UPDATE review_sessions SET model = MAX(model, ?), ui = MAX(ui, ?)${fromTerminal ? ", terminal_opened_at = ?" : ""}
       WHERE id = ?`,
      input.model ? 1 : 0,
      fromTerminal ? 0 : 1,
      ...(fromTerminal ? [at] : []),
      existing.id,
    );
    return existing.id;
  }
  const id = randomUUID();
  store.run(
    `INSERT INTO review_sessions (id, pr_key, surface, opened_at, terminal_opened_at, ui, model)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    keyOf(input.pr),
    input.surface,
    at,
    fromTerminal ? at : null,
    fromTerminal ? 0 : 1,
    input.model ? 1 : 0,
  );
  store.run(
    "DELETE FROM review_sessions WHERE opened_at < ?",
    new Date(now.getTime() - REVIEW_TIME_KEEP_DAYS * DAY).toISOString(),
  );
  return id;
}

/**
 * Active time the UI measured on a PR (its pane visible and focused, idle stretches over 2 min left out), added to the
 * session under way. Nothing without one: time before the briefing was opened, or after the review was sent, isn't
 * part of a review. Returns whether it counted.
 */
export function addActiveTime(store: AldenStore, pr: string, ms: number, now: Date = new Date()): boolean {
  if (!Number.isFinite(ms) || ms <= 0) return false;
  const session = openSession(store, pr, now);
  if (!session) return false;
  store.run(
    "UPDATE review_sessions SET active_ms = active_ms + ?, measured = 1 WHERE id = ?",
    Math.round(Math.min(ms, MAX_ACTIVE_REPORT_MS)),
    session.id,
  );
  return true;
}

/** Alden's model helped on the PR's session under way ("Draft my review", "Draft with Alden"). */
export function noteModelUsed(store: AldenStore, pr: string, now: Date = new Date()): void {
  const session = openSession(store, pr, now);
  if (session) store.run("UPDATE review_sessions SET model = 1 WHERE id = ?", session.id);
}

/** A comment was drafted on the PR (by you, Claude Code or Alden), during its session under way. */
export function noteDrafted(
  store: AldenStore,
  pr: string,
  source: "you" | "claude" | "alden",
  now: Date = new Date(),
): void {
  const session = openSession(store, pr, now);
  if (!session) return;
  store.run(
    "UPDATE review_sessions SET drafted = drafted + 1, drafted_by_alden = drafted_by_alden + ? WHERE id = ?",
    source === "alden" ? 1 : 0,
    session.id,
  );
}

/** You kept (or edited, making them yours) `count` of Alden's drafts on the PR, during its session under way. */
export function noteKept(store: AldenStore, pr: string, count: number, now: Date = new Date()): void {
  if (count <= 0) return;
  const session = openSession(store, pr, now);
  if (session) store.run("UPDATE review_sessions SET kept = kept + ? WHERE id = ?", count, session.id);
}

/** A sent review's session: what the stats and the `review_timed` event are made of. */
export interface ReviewTiming {
  activeMs: number;
  /** Active time measured in the UI; false: the terminal's estimate. */
  measured: boolean;
  wallMs: number;
  placesSeen: number;
  drafted: number;
  draftedByAlden: number;
  kept: number;
  comments: number;
  model: boolean;
  verdict: ReviewEvent;
}

/**
 * The review was sent: ends the PR's session, with the places you saw since it opened (from guided review and the
 * Diff tab, see `recordSeen`), the comments sent and the verdict. Undefined when no session was under way (the
 * briefing was never opened here, or `stats.reviewTime` was off).
 */
export function closeReviewSession(
  store: AldenStore,
  input: { pr: string; verdict: ReviewEvent; comments: number },
  now: Date = new Date(),
): ReviewTiming | undefined {
  const session = openSession(store, input.pr, now);
  if (!session) return undefined;
  const openedAt = Date.parse(session.opened_at);
  const seen =
    store.get<{ n: number }>(
      "SELECT COUNT(DISTINCT place_key) AS n FROM seen_places WHERE pr_key = ? AND seen_at >= ?",
      session.pr_key,
      session.opened_at,
    )?.n ?? 0;
  // Measured when the UI took part: it opened the briefing, or reported active time. Otherwise, the estimate.
  const measured = session.ui === 1 || session.measured === 1;
  const from = Date.parse(session.terminal_opened_at ?? session.opened_at);
  const activeMs = measured
    ? Number(session.active_ms)
    : Math.max(0, Math.min(now.getTime() - from, TERMINAL_ACTIVE_CAP_MS));
  store.run(
    `UPDATE review_sessions SET sent_at = ?, verdict = ?, sent_comments = ?, places_seen = ?, active_ms = ?, measured = ?
     WHERE id = ?`,
    now.toISOString(),
    input.verdict,
    input.comments,
    Number(seen),
    Math.round(activeMs),
    measured ? 1 : 0,
    session.id,
  );
  return {
    activeMs: Math.round(activeMs),
    measured,
    wallMs: Math.max(0, now.getTime() - openedAt),
    placesSeen: Number(seen),
    drafted: Number(session.drafted),
    draftedByAlden: Number(session.drafted_by_alden),
    kept: Number(session.kept),
    comments: input.comments,
    model: session.model === 1,
    verdict: input.verdict,
  };
}

/** `stats.reviewTime` was turned off with a review under way: forgets it rather than timing it half-recorded. */
export function dropReviewSession(store: AldenStore, pr: string, now: Date = new Date()): void {
  const session = openSession(store, pr, now);
  if (session) store.run("DELETE FROM review_sessions WHERE id = ?", session.id);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

const minutes = (ms: number | null) => (ms === null ? null : Math.round((ms / 60_000) * 10) / 10);

/**
 * "Time to review" over the last 14, 30 and 90 days, by the date each briefing was first opened: median active minutes
 * and median open-to-send minutes, with and without Alden's model, with sample sizes. Only reviews opened at least the
 * horizon ago count (see `REVIEW_TIME_HORIZON_HOURS`); those sent later than that count as the horizon.
 */
export function reviewTimeStats(
  store: AldenStore,
  options: { now?: Date; enabled?: boolean; windows?: readonly number[]; horizonHours?: number } = {},
): ReviewTimeStats {
  const now = options.now ?? new Date();
  const horizonMs = (options.horizonHours ?? REVIEW_TIME_HORIZON_HOURS) * HOUR;
  const windows = options.windows ?? REVIEW_TIME_WINDOWS;
  const longest = Math.max(...windows);
  const rows = store.all<SessionRow>(
    "SELECT * FROM review_sessions WHERE opened_at >= ? AND opened_at <= ?",
    new Date(now.getTime() - longest * DAY).toISOString(),
    now.toISOString(),
  );
  const group = (list: SessionRow[]): ReviewTimeGroup => ({
    count: list.length,
    activeMedianMinutes: minutes(median(list.map((r) => Number(r.active_ms)))),
    wallMedianMinutes: minutes(
      median(list.map((r) => Math.min(Date.parse(r.sent_at as string) - Date.parse(r.opened_at), horizonMs))),
    ),
    estimated: list.filter((r) => r.measured !== 1).length,
    small: list.length < REVIEW_TIME_SMALL_SAMPLE,
  });
  return {
    schemaVersion: REVIEW_TIME_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    enabled: options.enabled ?? true,
    horizonHours: horizonMs / HOUR,
    windows: windows.map((days) => {
      const from = new Date(now.getTime() - days * DAY);
      const inWindow = rows.filter((r) => Date.parse(r.opened_at) >= from.getTime());
      const old = inWindow.filter((r) => now.getTime() - Date.parse(r.opened_at) >= horizonMs);
      const sent = old.filter((r) => r.sent_at !== null);
      return {
        days,
        from: from.toISOString(),
        to: now.toISOString(),
        all: group(sent),
        withModel: group(sent.filter((r) => r.model === 1)),
        withoutModel: group(sent.filter((r) => r.model !== 1)),
        excluded: { tooRecent: inWindow.length - old.length, notSent: old.length - sent.length },
      };
    }),
  };
}
