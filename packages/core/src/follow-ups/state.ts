import { createHash } from "node:crypto";
import type { FollowUpEvent, FollowUpEventKind, ReviewThread, ReviewThreads } from "@alden/schema";
import { repliedToYou, yourThreads } from "../github/threads.js";

/**
 * What a check of a PR you reviewed remembers (`follow_ups.state`, as JSON), so the next check can tell what's new:
 * each thread you're in as it was, the last re-review request it saw, and the round it last told you it was your turn.
 * Only your threads are kept; a thread you're not in never notifies you.
 */
export interface FollowUpState {
  version: 1;
  /** The PR's head commit when its threads were last read. */
  head?: string;
  /** Your threads by node id. */
  threads: Record<string, ThreadSnapshot>;
  /** The latest `rereviewRequestedAt` seen, so a request is told once. */
  rereviewSeen?: string;
  /**
   * The round "your turn" was last recorded for: your last comment's id across your threads. A new comment of yours
   * starts a new round, so the next time everything is answered is told again.
   */
  turn?: string;
}

export interface ThreadSnapshot {
  resolved: boolean;
  outdated: boolean;
  /** The id of its newest comment when last seen: anything after it is new. */
  last: string;
  /** Unresolved, and someone else had the last word after you. */
  replied: boolean;
  /** "src/pay.ts:40", for the event's text. */
  where: string;
}

/** The PR an event is about, as the check found it. */
export interface FollowedPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  /** The PR's author, who usually asks for the re-review. */
  author?: string | undefined;
}

export const emptyState = (): FollowUpState => ({ version: 1, threads: {} });

/** The stored state, or undefined when it's missing or unreadable (the next check then takes a new baseline). */
export function parseState(text: string | undefined | null): FollowUpState | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as Partial<FollowUpState>;
    if (parsed.version !== 1 || typeof parsed.threads !== "object" || parsed.threads === null) return undefined;
    return parsed as FollowUpState;
  } catch {
    return undefined;
  }
}

const whereOf = (t: ReviewThread) => {
  const line = t.line ?? t.originalLine;
  return line === null ? t.path : `${t.path}:${line}`;
};

/** Your last comment's id across your threads: the round "your turn" is counted in. */
function lastWord(threads: ReviewThread[]): string | undefined {
  let last: { id: string; at: string } | undefined;
  for (const t of threads) {
    for (const c of t.comments) if (c.isYou && (!last || c.createdAt >= last.at)) last = { id: c.id, at: c.createdAt };
  }
  return last?.id;
}

/** Every thread you're in is resolved or has a reply from someone else after your last word. */
export const isYourTurn = (threads: ReviewThread[]) =>
  threads.length > 0 && threads.every((t) => t.isResolved || repliedToYou(t));

/** An event id: the same happening on the same PR always gets the same one, so it's recorded once. */
export function eventId(kind: FollowUpEventKind, prKey: string, ...parts: string[]): string {
  return `fu-${kind}-${createHash("sha256")
    .update([prKey, kind, ...parts].join("|"))
    .digest("hex")
    .slice(0, 24)}`;
}

/** The state of your threads, as a check saves it. */
export function snapshot(threads: ReviewThreads, previous: FollowUpState | undefined): FollowUpState {
  const mine = yourThreads(threads.threads);
  const state: FollowUpState = {
    version: 1,
    head: threads.headSha,
    threads: Object.fromEntries(
      mine.map((t) => [
        t.id,
        {
          resolved: t.isResolved,
          outdated: t.isOutdated,
          last: t.comments.at(-1)?.id ?? "",
          replied: !t.isResolved && repliedToYou(t),
          where: whereOf(t),
        } satisfies ThreadSnapshot,
      ]),
    ),
  };
  if (previous?.rereviewSeen) state.rereviewSeen = previous.rereviewSeen;
  if (previous?.turn) state.turn = previous.turn;
  return state;
}

const plainName = (login: string | null) => login ?? "Someone";

/**
 * What's new on a PR since `previous`: replies after yours, threads resolved or made outdated, a re-review request
 * newer than the last one seen, and "your turn" once per round. `threads` is undefined when the PR wasn't read again
 * (it hasn't changed): then only a re-review request can be new. Without `previous` it's the first check: the state is
 * the baseline, and nothing that already happened is an event.
 */
export function compareFollowUp(
  pr: FollowedPr,
  previous: FollowUpState | undefined,
  threads: ReviewThreads | undefined,
  rereviewRequestedAt: string | undefined,
  now: Date,
): { state: FollowUpState; events: FollowUpEvent[] } {
  const prKey = `${pr.repo}#${pr.number}`.toLowerCase();
  const base = { pr: `${pr.repo}#${pr.number}`, title: pr.title, url: pr.url };
  const events: FollowUpEvent[] = [];
  const at = now.toISOString();
  const state = threads ? snapshot(threads, previous) : { ...(previous ?? emptyState()) };
  const first = previous === undefined;

  if (rereviewRequestedAt && (!state.rereviewSeen || rereviewRequestedAt > state.rereviewSeen)) {
    if (!first) {
      events.push({
        ...base,
        id: eventId("rereview", prKey, rereviewRequestedAt),
        kind: "rereview",
        at: rereviewRequestedAt,
        text: pr.author ? `${pr.author} asked you to review again` : "You were asked to review again",
      });
    }
    state.rereviewSeen = rereviewRequestedAt;
  }

  if (!threads) return { state, events };
  const mine = yourThreads(threads.threads);

  if (!first) {
    for (const t of mine) {
      const before = previous.threads[t.id];
      const where = whereOf(t);
      // Others' comments after your first one in the thread, and after the newest one seen last time.
      const firstYours = t.comments.findIndex((c) => c.isYou);
      const seen = before ? t.comments.findIndex((c) => c.id === before.last) : -1;
      // The newest comment seen was deleted: what came after it can't be told from what was there, so say nothing.
      const from = before && seen === -1 ? t.comments.length : Math.max(firstYours, seen) + 1;
      for (const c of t.comments.slice(from)) {
        if (c.isYou) continue;
        events.push({
          ...base,
          id: eventId("reply", prKey, c.id),
          kind: "reply",
          at: c.createdAt,
          text: `${plainName(c.author)} replied to your comment on ${where}`,
        });
      }
      if (t.isResolved && before && !before.resolved) {
        events.push({
          ...base,
          // A thread resolved, reopened, answered and resolved again is told again; resolved twice in a row isn't.
          id: eventId("resolved", prKey, t.id, t.comments.at(-1)?.id ?? ""),
          kind: "resolved",
          at,
          text: `Your comment on ${where} was resolved`,
        });
      }
      if (t.isOutdated && before && !before.outdated) {
        events.push({
          ...base,
          id: eventId("outdated", prKey, t.id),
          kind: "outdated",
          at,
          text: `A push changed the code under your comment on ${t.path}`,
        });
      }
    }
  }

  const round = lastWord(mine);
  if (round && isYourTurn(mine) && state.turn !== round) {
    if (!first) {
      events.push({
        ...base,
        id: eventId("your-turn", prKey, round),
        kind: "your-turn",
        at,
        text: "Your turn: every comment you left is resolved or answered",
      });
    }
    state.turn = round;
  }
  return { state, events };
}

/** How many of your threads there are, how many are resolved, and how many have a reply waiting on you. */
export function stateCounts(state: FollowUpState): { yourThreads: number; resolved: number; replied: number } {
  const threads = Object.values(state.threads);
  return {
    yourThreads: threads.length,
    resolved: threads.filter((t) => t.resolved).length,
    replied: threads.filter((t) => !t.resolved && t.replied).length,
  };
}
