import {
  type FollowUpEvent,
  FollowUpEventSchema,
  type FollowUpLevel,
  type FollowUpNews,
  type RankedPullRequest,
  type RankedQueue,
  type YourTurnItem,
} from "@alden/schema";
import type { GitHubClient } from "../github/client.js";
import type { AldenStore } from "../store/db.js";
import { checkFollowUps, type FollowUpQueueRow } from "./check.js";
import { type FollowUpState, parseState } from "./state.js";
import { listWatches, prKeyOf } from "./watch.js";

/**
 * Your turn: the follow-ups you haven't seen, in the queue. A follow-up event is seen once you open its PR in Alden
 * (`markFollowUpsSeen`), whether or not the desktop app has notified you of it: notifications and the group share the
 * events, and seeing one also counts as told.
 *
 * A PR still in the queue (a re-review is always there, under Needs you) carries its news on its own row
 * (`followUp.news`); every other PR with news is in `yourTurn`, so no PR is listed twice. Re-review requests aren't
 * news here: the row's Re-review mark already says it.
 */

/** The kinds of follow-up that make news: a re-review is its own row in the queue. */
const NEWS_KINDS: readonly FollowUpEvent["kind"][] = ["reply", "resolved", "outdated", "your-turn"];

/**
 * Whether a PR at `level` shows news: Off hides it, Re-review only shows only re-reviews (which are queue rows, not
 * news), and When it's your turn and Every reply show it all. The level decides what interrupts you; the group is
 * there when you look, so it doesn't wait for the whole round to be answered.
 */
export const levelShowsNews = (level: FollowUpLevel) => level === "your-turn" || level === "every-reply";

/** Whether any PR could have news: the global level isn't Off, or some PR has a level of its own that isn't. */
export function followUpsWanted(store: AldenStore, global: FollowUpLevel): boolean {
  return global !== "off" || listWatches(store).some((w) => w.level !== "off");
}

/** A ranked queue's rows you reviewed before, as the follow-up check takes them (for re-review requests). */
export function followUpRows(queue: RankedQueue): FollowUpQueueRow[] {
  return [...queue.needsYou, ...queue.fastTrack]
    .filter((r) => r.followUp)
    .map((r) => ({ pr: r.pr, followUp: r.followUp }));
}

export type FollowUpRefresh = "off" | "checked" | "skipped" | "failed" | "pending";

/**
 * The follow-up check, as part of fetching the queue: the same one the desktop app runs, with the same limits (one
 * request to find the PRs you reviewed, at most once a minute across every Alden on this machine; a PR's threads read
 * only when its `updatedAt` moved). Nothing is asked of GitHub when no PR could show news. Waits at most `waitMs` (the
 * check carries on, and the next queue shows what it found); never throws: what's stored still shows.
 */
export async function refreshFollowUps(
  client: GitHubClient,
  store: AldenStore,
  options: { global: FollowUpLevel; queue?: FollowUpQueueRow[]; waitMs?: number; now?: Date },
): Promise<FollowUpRefresh> {
  let wanted: boolean;
  try {
    wanted = followUpsWanted(store, options.global);
  } catch {
    return "failed"; // the database is locked or damaged: the queue still stands
  }
  if (!wanted) return "off";
  const run = checkFollowUps(client, store, {
    global: options.global,
    ...(options.queue ? { queue: options.queue } : {}),
    ...(options.now ? { now: options.now } : {}),
  }).then(
    (result): FollowUpRefresh => (result.skipped ? "skipped" : "checked"),
    (): FollowUpRefresh => "failed",
  );
  if (options.waitMs === undefined) return run;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<FollowUpRefresh>((resolve) => {
    timer = setTimeout(() => resolve("pending"), options.waitMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([run, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Marks everything that happened on a PR seen (and told): you opened it. Returns how many events were waiting. */
export function markFollowUpsSeen(store: AldenStore, repo: string, number: number): number {
  return store.run(
    "UPDATE follow_up_events SET seen = 1, notified = 1 WHERE pr_key = ? AND (seen = 0 OR notified = 0)",
    prKeyOf(repo, number),
  ).changes;
}

const people = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? "Someone")
    : names.length === 2
      ? `${names[0]} and ${names[1]}`
      : `${names[0]} and ${names.length - 1} others`;

/**
 * "Ana replied to 2 of your comments · 1 resolved": who answered and on how many of your threads, then threads
 * resolved and made outdated. Each count is of threads, not comments.
 */
export function newsText(news: { who: string[]; replies: number; resolved: number; outdated: number }): string {
  const parts: string[] = [];
  const of = (n: number) => (n === 1 ? "your comment" : `${n} of your comments`);
  if (news.replies > 0) parts.push(`${people(news.who)} replied to ${of(news.replies)}`);
  if (news.resolved > 0) {
    parts.push(
      parts.length > 0
        ? `${news.resolved} resolved`
        : news.resolved === 1
          ? "Your comment was resolved"
          : `${news.resolved} of your comments resolved`,
    );
  }
  if (news.outdated > 0) {
    parts.push(parts.length > 0 ? `${news.outdated} outdated by a push` : `A push outdated ${of(news.outdated)}`);
  }
  return parts.join(" · ");
}

/** Who wrote a reply: the event says, or (recorded before it did) its text does. */
const replier = (e: FollowUpEvent) => e.by ?? /^(.+?) replied to your comment/.exec(e.text)?.[1] ?? "Someone";

/**
 * Whether an event is still news, given the PR's threads as last read: a thread you resolved yourself is done with,
 * and a reply you've answered since (you had the last word, on GitHub or from Alden) isn't waiting on you.
 */
function stillNews(event: FollowUpEvent, state: FollowUpState | undefined): boolean {
  const thread = event.thread ? state?.threads[event.thread] : undefined;
  if (!thread) return true;
  if (thread.resolvedByYou) return false;
  if (event.kind === "reply") return thread.resolved || thread.replied;
  return true;
}

/** A PR's unseen events as one piece of news, or undefined when none of them is news any more. */
export function newsOf(events: FollowUpEvent[], state: FollowUpState | undefined): FollowUpNews | undefined {
  const kept = events.filter((e) => NEWS_KINDS.includes(e.kind) && stillNews(e, state));
  const threadsOf = (kind: FollowUpEvent["kind"]) =>
    new Set(kept.filter((e) => e.kind === kind).map((e) => e.thread ?? e.id)).size;
  const replies = kept.filter((e) => e.kind === "reply");
  const counted = kept.filter((e) => e.kind !== "your-turn");
  if (counted.length === 0) return undefined;
  const latest = (list: FollowUpEvent[]) => [...list].sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  const counts = { replies: threadsOf("reply"), resolved: threadsOf("resolved"), outdated: threadsOf("outdated") };
  const who = [...new Set([...replies].reverse().map(replier))];
  // The thread to open on: the newest reply's, else the newest of the rest.
  const thread = (latest(replies.filter((e) => e.thread)) ?? latest(counted.filter((e) => e.thread)))?.thread;
  return {
    text: newsText({ who, ...counts }),
    at: (latest(counted) as FollowUpEvent).at,
    ...counts,
    ...(thread ? { thread } : {}),
    events: kept.map((e) => e.id),
  };
}

interface UnseenRow {
  id: string;
  pr_key: string;
  event: string;
  state: string;
}

/** Each followed PR's unseen news, at its level (its own, else `global`), by its key ("owner/repo#12", lowercased). */
export function unseenNews(
  store: AldenStore,
  global: FollowUpLevel,
): Map<string, { event: FollowUpEvent; news: FollowUpNews }> {
  // Only PRs still followed: a merged or closed one is done with.
  const rows = store.all<UnseenRow>(
    `SELECT e.id, e.pr_key, e.event, f.state FROM follow_up_events e JOIN follow_ups f ON f.pr_key = e.pr_key
     WHERE e.seen = 0 ORDER BY e.at, e.id`,
  );
  const levels = new Map(listWatches(store).map((w) => [prKeyOf(w.repo, w.number), w.level]));
  const byPr = new Map<string, { events: FollowUpEvent[]; state: string }>();
  for (const row of rows) {
    if (!levelShowsNews(levels.get(row.pr_key) ?? global)) continue;
    const parsed = FollowUpEventSchema.safeParse(safeJson(row.event));
    if (!parsed.success) continue;
    const entry = byPr.get(row.pr_key) ?? { events: [], state: row.state };
    entry.events.push(parsed.data);
    byPr.set(row.pr_key, entry);
  }
  const out = new Map<string, { event: FollowUpEvent; news: FollowUpNews }>();
  for (const [key, { events, state }] of byPr) {
    const news = newsOf(events, parseState(state));
    if (news) out.set(key, { event: events.at(-1) as FollowUpEvent, news });
  }
  return out;
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Whether a repo is in the queue's scope (`queue.repos`, `queue.orgs`, `queue.ignore`, or `--repo` and `--org`). */
export function repoInScope(repo: string, scope: { repos?: string[]; orgs?: string[]; ignore?: string[] }): boolean {
  const lower = repo.toLowerCase();
  const owner = lower.split("/")[0] ?? "";
  if ((scope.ignore ?? []).some((i) => [lower, owner].includes(i.toLowerCase()))) return false;
  const repos = (scope.repos ?? []).map((r) => r.toLowerCase());
  const orgs = (scope.orgs ?? []).map((o) => o.toLowerCase());
  return (repos.length === 0 && orgs.length === 0) || repos.includes(lower) || orgs.includes(owner);
}

/**
 * The queue with what you haven't seen on the PRs you reviewed: a queue row's news on its `followUp`, and every other
 * PR's in `yourTurn` (newest first, in the queue's scope). Read from the database only; never asks GitHub.
 */
export function withYourTurn(
  store: AldenStore,
  queue: RankedQueue,
  options: { global: FollowUpLevel; scope?: { repos?: string[]; orgs?: string[]; ignore?: string[] } },
): RankedQueue {
  const unseen = unseenNews(store, options.global);
  const onRow = (row: RankedPullRequest): RankedPullRequest => {
    if (!row.followUp) return row;
    const key = prKeyOf(row.pr.repo, row.pr.number);
    const found = unseen.get(key);
    unseen.delete(key);
    const { news: _, ...followUp } = row.followUp;
    return { ...row, followUp: found ? { ...followUp, news: found.news } : followUp };
  };
  const needsYou = queue.needsYou.map(onRow);
  const fastTrack = queue.fastTrack.map(onRow);
  const yourTurn: YourTurnItem[] = [...unseen.values()]
    .map(({ event, news }) => {
      const [, repo = "", number = "0"] = /^(.+)#(\d+)$/.exec(event.pr) ?? [];
      return { pr: event.pr, repo, number: Number(number), title: event.title, url: event.url, news };
    })
    .filter((item) => item.repo !== "" && repoInScope(item.repo, options.scope ?? {}))
    .sort((a, b) => b.news.at.localeCompare(a.news.at) || a.pr.localeCompare(b.pr));
  return { ...queue, needsYou, fastTrack, yourTurn };
}
