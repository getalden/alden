import {
  type FollowUpEvent,
  FollowUpEventSchema,
  type FollowUpLevel,
  type FollowUpNotification,
  type FollowUpSummary,
  type RankedPullRequest,
  type RankedQueue,
} from "@alden/schema";
import type { AldenStore } from "../store/db.js";
import { parseState, stateCounts } from "./state.js";
import { levelAllows } from "./watch.js";

/**
 * What the desktop app shows: one notification per PR, covering every event not yet shown that the PR's level lets
 * through, and acknowledged (`ackFollowUps`) once shown, so nothing is told twice. Events the level holds back are
 * marked shown as they're found, so raising a level later doesn't bring old news.
 */

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Ana asked you to review again · 2 replies, 1 resolved", or one event's own line when it's alone. */
export function notificationText(events: FollowUpEvent[]): string {
  if (events.length === 1) return (events[0] as FollowUpEvent).text;
  const of = (kind: FollowUpEvent["kind"]) => events.filter((e) => e.kind === kind);
  const rereview = of("rereview").at(-1);
  const counts = [
    of("reply").length > 0 ? count(of("reply").length, "reply", "replies") : "",
    of("resolved").length > 0 ? `${of("resolved").length} resolved` : "",
    of("outdated").length > 0 ? `${of("outdated").length} outdated by a push` : "",
  ].filter(Boolean);
  const turn = of("your-turn").length > 0;
  const parts = [
    rereview?.text,
    counts.length > 0 ? counts.join(", ") : undefined,
    turn
      ? counts.length > 0 || rereview
        ? "your turn"
        : "Your turn: every comment you left is resolved or answered"
      : "",
  ].filter(Boolean) as string[];
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface EventRow {
  id: string;
  pr_key: string;
  event: string;
}

/**
 * Events not yet shown, one notification per PR (oldest news first), filtered by each PR's level: its own, else
 * `global`. Events below the level are marked shown here, never returned later.
 */
export function pendingFollowUps(store: AldenStore, global: FollowUpLevel): FollowUpNotification[] {
  const rows = store.all<EventRow>("SELECT id, pr_key, event FROM follow_up_events WHERE notified = 0 ORDER BY at, id");
  const levels = new Map(
    store
      .all<{ pr_key: string; level: string }>("SELECT pr_key, level FROM pr_watch")
      .map((r) => [r.pr_key, r.level as FollowUpLevel]),
  );
  const held: string[] = [];
  const byPr = new Map<string, FollowUpEvent[]>();
  for (const row of rows) {
    let event: FollowUpEvent;
    try {
      event = FollowUpEventSchema.parse(JSON.parse(row.event));
    } catch {
      held.push(row.id);
      continue;
    }
    if (!levelAllows(levels.get(row.pr_key) ?? global, event.kind)) {
      held.push(row.id);
      continue;
    }
    byPr.set(row.pr_key, [...(byPr.get(row.pr_key) ?? []), event]);
  }
  if (held.length > 0) ackFollowUps(store, held);
  return [...byPr.values()].map((events) => {
    const latest = events.at(-1) as FollowUpEvent;
    return {
      pr: latest.pr,
      title: latest.title,
      url: latest.url,
      text: notificationText(events),
      events: events.map((e) => e.id),
    };
  });
}

/** Marks events shown. Returns how many were waiting. */
export function ackFollowUps(store: AldenStore, ids: string[]): number {
  if (ids.length === 0) return 0;
  return store.transaction(() =>
    ids.reduce(
      (n, id) => n + store.run("UPDATE follow_up_events SET notified = 1 WHERE id = ? AND notified = 0", id).changes,
      0,
    ),
  );
}

/**
 * A queue row's follow-up with your threads counted from the last check: how many you're in, how many are resolved,
 * and how many have a reply waiting on you. As it was when the PR isn't followed yet.
 */
export function withFollowUpCounts(store: AldenStore, summary: FollowUpSummary): FollowUpSummary {
  const row = store.get<{ state: string }>("SELECT state FROM follow_ups WHERE pr_key = ?", summary.pr.toLowerCase());
  const state = parseState(row?.state);
  return state ? { ...summary, ...stateCounts(state) } : summary;
}

/** `withFollowUpCounts` on every row of a ranked queue that has a follow-up; other rows are left as they are. */
export function fillFollowUpCounts(store: AldenStore, queue: RankedQueue): RankedQueue {
  const fill = (row: RankedPullRequest): RankedPullRequest =>
    row.followUp ? { ...row, followUp: withFollowUpCounts(store, row.followUp) } : row;
  return {
    ...queue,
    needsYou: queue.needsYou.map(fill),
    fastTrack: queue.fastTrack.map(fill),
    ...(queue.dismissed ? { dismissed: queue.dismissed.map(fill) } : {}),
  };
}
