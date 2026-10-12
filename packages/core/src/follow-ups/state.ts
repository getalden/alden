import { createHash } from "node:crypto";
import type { FollowUpEvent, FollowUpEventKind, ReviewThread, ReviewThreadComment, ReviewThreads } from "@alden/schema";
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
  /** You resolved it yourself: done with, by you. */
  resolvedByYou?: boolean;
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

/**
 * Your threads that still wait on someone else: a thread you resolved yourself is done with by you, so it's neither
 * an answer to you nor something to wait for.
 */
const waiting = (threads: ReviewThread[]) => threads.filter((t) => !t.resolvedByYou);

/** Your last comment's id across the threads still waiting: the round "your turn" is counted in. */
function lastWord(threads: ReviewThread[]): string | undefined {
  let last: { id: string; at: string } | undefined;
  for (const t of waiting(threads)) {
    for (const c of t.comments) if (c.isYou && (!last || c.createdAt >= last.at)) last = { id: c.id, at: c.createdAt };
  }
  return last?.id;
}

/**
 * Every thread of yours that you didn't resolve yourself is resolved by someone else or has a reply after your last
 * word, and there's at least one. Resolving your own threads (say, before approving) never makes it your turn.
 */
export function isYourTurn(threads: ReviewThread[]): boolean {
  const open = waiting(threads);
  return open.length > 0 && open.every((t) => t.isResolved || repliedToYou(t));
}

/** Your latest comment in a thread, as a time. */
const yourLastAt = (t: ReviewThread) => t.comments.filter((c) => c.isYou).at(-1)?.createdAt;

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
          ...(t.resolvedByYou ? { resolvedByYou: true } : {}),
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

/** How long before the baseline your comments still count as part of the review it marks (drafted, then submitted). */
const REVIEW_SPAN_MS = 24 * 60 * 60 * 1000;

/**
 * Where a PR's first check starts from: what happened after `at` is news. `at` is your last review of the PR (or, when
 * that's unknown or older, when follow-ups first ran on this machine, so a fresh install isn't flooded with history).
 * `untimed` says whether resolves and outdated threads count too: GitHub gives them no time, so they count only when
 * `at` is a review of yours, on the threads you spoke in during it (or after).
 */
export interface FollowUpBaseline {
  at: string;
  untimed: boolean;
}

/**
 * What's new on a PR since `previous`: replies after yours, threads resolved (by someone else) or made outdated, a
 * re-review request newer than the last one seen, and "your turn" once per round. `threads` is undefined when the PR
 * wasn't read again (it hasn't changed): then only a re-review request can be new.
 *
 * Without `previous` it's the PR's first check. With a `baseline`, what happened after it is news (see
 * `FollowUpBaseline`), and "your turn" is told when that news completes it. Without one, the state is the baseline and
 * nothing that already happened is an event.
 */
export function compareFollowUp(
  pr: FollowedPr,
  previous: FollowUpState | undefined,
  threads: ReviewThreads | undefined,
  rereviewRequestedAt: string | undefined,
  now: Date,
  baseline?: FollowUpBaseline,
): { state: FollowUpState; events: FollowUpEvent[] } {
  const prKey = `${pr.repo}#${pr.number}`.toLowerCase();
  const base = { pr: `${pr.repo}#${pr.number}`, title: pr.title, url: pr.url };
  const events: FollowUpEvent[] = [];
  const at = now.toISOString();
  const state = threads ? snapshot(threads, previous) : { ...(previous ?? emptyState()) };
  const first = previous === undefined;
  /** First check with nothing to start from: only the state is taken. */
  const quiet = first && !baseline;

  const newRequest = first
    ? rereviewRequestedAt !== undefined && baseline !== undefined && rereviewRequestedAt > baseline.at
    : rereviewRequestedAt !== undefined && (!state.rereviewSeen || rereviewRequestedAt > state.rereviewSeen);
  if (newRequest && rereviewRequestedAt) {
    events.push({
      ...base,
      id: eventId("rereview", prKey, rereviewRequestedAt),
      kind: "rereview",
      at: rereviewRequestedAt,
      text: pr.author ? `${pr.author} asked you to review again` : "You were asked to review again",
    });
  }
  if (rereviewRequestedAt && (!state.rereviewSeen || rereviewRequestedAt > state.rereviewSeen)) {
    state.rereviewSeen = rereviewRequestedAt;
  }

  if (!threads) return { state, events };
  const mine = yourThreads(threads.threads);
  const reply = (t: ReviewThread, c: ReviewThreadComment): FollowUpEvent => ({
    ...base,
    id: eventId("reply", prKey, c.id),
    kind: "reply",
    at: c.createdAt,
    text: `${plainName(c.author)} replied to your comment on ${whereOf(t)}`,
    thread: t.id,
    ...(c.author ? { by: c.author } : {}),
  });
  const resolved = (t: ReviewThread): FollowUpEvent => ({
    ...base,
    // A thread resolved, reopened, answered and resolved again is told again; resolved twice in a row isn't.
    id: eventId("resolved", prKey, t.id, t.comments.at(-1)?.id ?? ""),
    kind: "resolved",
    at,
    text: `Your comment on ${whereOf(t)} was resolved`,
    thread: t.id,
  });
  const outdated = (t: ReviewThread): FollowUpEvent => ({
    ...base,
    id: eventId("outdated", prKey, t.id),
    kind: "outdated",
    at,
    text: `A push changed the code under your comment on ${t.path}`,
    thread: t.id,
  });

  if (!first) {
    for (const t of mine) {
      const before = previous.threads[t.id];
      // Others' comments after your first one in the thread, and after the newest one seen last time.
      const firstYours = t.comments.findIndex((c) => c.isYou);
      const seen = before ? t.comments.findIndex((c) => c.id === before.last) : -1;
      // The newest comment seen was deleted: what came after it can't be told from what was there, so say nothing.
      const from = before && seen === -1 ? t.comments.length : Math.max(firstYours, seen) + 1;
      for (const c of t.comments.slice(from)) if (!c.isYou) events.push(reply(t, c));
      if (t.isResolved && !t.resolvedByYou && before && !before.resolved) events.push(resolved(t));
      if (t.isOutdated && before && !before.outdated) events.push(outdated(t));
    }
  } else if (baseline) {
    const since = Date.parse(baseline.at) - REVIEW_SPAN_MS;
    for (const t of mine) {
      const firstYours = t.comments.findIndex((c) => c.isYou);
      for (const c of t.comments.slice(firstYours + 1)) {
        if (!c.isYou && c.createdAt > baseline.at) events.push(reply(t, c));
      }
      const lastYours = yourLastAt(t);
      // Untimed changes count only on threads from the review the baseline marks, or later.
      if (!baseline.untimed || !lastYours || Date.parse(lastYours) < since) continue;
      if (t.isResolved && !t.resolvedByYou) events.push(resolved(t));
      if (t.isOutdated) events.push(outdated(t));
    }
  }

  const round = lastWord(mine);
  if (round && isYourTurn(mine) && state.turn !== round) {
    // On a first check, it's news only when something after the baseline made it so.
    const told = first ? !quiet && events.some((e) => e.kind === "reply" || e.kind === "resolved") : true;
    if (told) {
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
