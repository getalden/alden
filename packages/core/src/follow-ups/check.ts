import type { FollowUpEvent, FollowUpLevel, ReviewThreads } from "@alden/schema";
import type { GitHubClient } from "../github/client.js";
import { fetchReviewThreads } from "../github/threads.js";
import type { AldenStore } from "../store/db.js";
import { compareFollowUp, type FollowedPr, type FollowUpState, parseState } from "./state.js";
import { clearWatch, levelAllows, prKeyOf } from "./watch.js";

/**
 * Follow-ups: what happened on the PRs you reviewed lately, read from GitHub (read only) and recorded as events for the
 * desktop app to tell you about at the level you chose.
 *
 * The PRs followed are the open ones you reviewed in the last `FOLLOW_UP_WINDOW_DAYS`: GitHub's own search
 * (`reviewed-by:@me`), the PRs you sent comments on from Alden, the PRs with their own level (`alden watch`), the ones
 * already followed, and the queue's rows that say you reviewed them before (their `followUp`). One GraphQL request
 * finds them all with their last update; only a PR whose `updatedAt` moved since the last check (or that was never
 * checked) has its threads read again, a few at a time. A merged or closed PR stops being followed, and loses its own
 * level.
 */

/** How long after GitHub last saw a change a PR stays followed. */
export const FOLLOW_UP_WINDOW_DAYS = 14;
/** The PRs the search brings back: one page. */
export const FOLLOW_UP_SEARCH_LIMIT = 50;
/** PRs looked up by name in the same request (sent comments, overrides, already followed), newest first. */
export const FOLLOW_UP_LOOKUP_LIMIT = 50;
/** Two checks closer together than this share the first one's result: GitHub is asked at most once a minute. */
export const FOLLOW_UP_MIN_INTERVAL_MS = 60_000;
const CONCURRENCY = 4;
const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "follow_ups:checked_at";
/** Events are kept this long, notified or not. */
const EVENTS_KEEP_DAYS = 30;

const PR_FIELDS = "number title url updatedAt state author { login } repository { nameWithOwner }";

interface RawFollowed {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  author: { login: string } | null;
  repository: { nameWithOwner: string };
}

/** The one request: who you are, the search, and each looked-up PR by owner, name and number (all as variables). */
export function followedQuery(lookups: number): string {
  const vars = Array.from({ length: lookups }, (_, i) => `, $o${i}: String!, $n${i}: String!, $k${i}: Int!`).join("");
  const fields = Array.from(
    { length: lookups },
    (_, i) => `p${i}: repository(owner: $o${i}, name: $n${i}) { pullRequest(number: $k${i}) { ${PR_FIELDS} } }`,
  ).join("\n  ");
  return `query($q: String!, $first: Int!${vars}) {
  viewer { login }
  search(query: $q, type: ISSUE, first: $first) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
  ${fields}
}`;
}

/** The search for PRs you reviewed that are still open and changed in the window. */
export function followedSearch(now: Date): string {
  const since = new Date(now.getTime() - FOLLOW_UP_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  return `is:pr is:open archived:false reviewed-by:@me updated:>=${since}`;
}

/** A queue row as the check needs it: the PR, and the queue's word on whether you were asked to review again. */
export interface FollowUpQueueRow {
  pr: { repo: string; number: number; title: string; url: string; author?: string | null; updatedAt: string };
  followUp?: { rereviewRequestedAt?: string | undefined } | undefined;
}

export interface FollowUpCheckOptions {
  /** `notifications.followUps`: events below a PR's level are recorded as already notified. */
  global: FollowUpLevel;
  /** The last ranked queue's rows: those with `followUp` are followed, and their re-review requests told. */
  queue?: FollowUpQueueRow[];
  now?: Date;
  concurrency?: number;
  /** Defaults to `FOLLOW_UP_MIN_INTERVAL_MS`; 0 checks every time. */
  minIntervalMs?: number;
}

export interface FollowUpCheckResult {
  /** PRs followed this check. */
  followed: number;
  /** PRs whose threads were read (their `updatedAt` moved, or they're new). */
  read: number;
  /** PRs whose threads couldn't be read (tried again next check). */
  failed: number;
  /** PRs no longer followed: merged, closed or gone. */
  ended: number;
  /** Events newly recorded, at any level. */
  recorded: FollowUpEvent[];
  /** Asked again within the minimum interval: nothing was asked of GitHub. */
  skipped?: boolean;
}

interface Followed extends FollowedPr {
  key: string;
  updatedAt: string;
  rereviewRequestedAt?: string | undefined;
}

interface FollowRow {
  pr_key: string;
  repo: string;
  number: number;
  updated_at: string | null;
  state: string;
}

/** Runs one GraphQL request, keeping what GitHub returned when some looked-up PRs or repos aren't there. */
async function graphqlPartial<T>(client: GitHubClient, query: string, variables: Record<string, unknown>): Promise<T> {
  try {
    return await client.graphql<T>(query, variables);
  } catch (error) {
    const { data, errors } = error as { data?: T; errors?: { type?: string }[] };
    if (data && errors?.every((e) => e.type === "NOT_FOUND")) return data;
    throw error;
  }
}

const toFollowed = (raw: RawFollowed): Followed => ({
  key: prKeyOf(raw.repository.nameWithOwner, raw.number),
  repo: raw.repository.nameWithOwner,
  number: raw.number,
  title: raw.title,
  url: raw.url,
  author: raw.author?.login,
  updatedAt: raw.updatedAt,
});

/** The PRs to look up by name: overrides first (they must end when the PR does), then sent comments, then followed. */
function lookups(store: AldenStore, since: string, known: Set<string>): { repo: string; number: number }[] {
  const rows = [
    ...store.all<{ repo: string; number: number }>("SELECT repo, number FROM pr_watch ORDER BY set_at DESC"),
    ...store.all<{ repo: string; number: number }>(
      "SELECT repo, number FROM sent_comments WHERE sent_at >= ? GROUP BY pr_key ORDER BY MAX(sent_at) DESC",
      since,
    ),
    ...store.all<{ repo: string; number: number }>(
      "SELECT repo, number FROM follow_ups ORDER BY COALESCE(updated_at, checked_at) DESC",
    ),
  ];
  const out: { repo: string; number: number }[] = [];
  const seen = new Set(known);
  for (const row of rows) {
    const key = prKeyOf(row.repo, Number(row.number));
    if (seen.has(key) || !/^[\w.-]+\/[\w.-]+$/.test(row.repo)) continue;
    seen.add(key);
    out.push({ repo: row.repo, number: Number(row.number) });
    if (out.length >= FOLLOW_UP_LOOKUP_LIMIT) break;
  }
  return out;
}

/** Stops following a PR: its state, its own level, and anything not yet told (the PR is done with). */
function endFollow(store: AldenStore, repo: string, number: number): void {
  const key = prKeyOf(repo, number);
  store.transaction(() => {
    store.run("DELETE FROM follow_ups WHERE pr_key = ?", key);
    store.run("UPDATE follow_up_events SET notified = 1 WHERE pr_key = ? AND notified = 0", key);
    clearWatch(store, repo, number);
  });
}

/** The level that applies to a PR: its own, else the global one. */
function levelOf(store: AldenStore, key: string, global: FollowUpLevel): FollowUpLevel {
  const row = store.get<{ level: string }>("SELECT level FROM pr_watch WHERE pr_key = ?", key);
  return (row?.level as FollowUpLevel | undefined) ?? global;
}

/** Saves a PR's new state and its events; events below its level are recorded as notified, so they're never shown. */
function save(
  store: AldenStore,
  pr: Followed,
  state: FollowUpState,
  events: FollowUpEvent[],
  read: boolean,
  global: FollowUpLevel,
  now: Date,
): FollowUpEvent[] {
  const level = levelOf(store, pr.key, global);
  const recorded: FollowUpEvent[] = [];
  store.transaction(() => {
    for (const event of events) {
      const added = store.run(
        "INSERT OR IGNORE INTO follow_up_events (id, pr_key, kind, at, event, notified) VALUES (?, ?, ?, ?, ?, ?)",
        event.id,
        pr.key,
        event.kind,
        event.at,
        JSON.stringify(event),
        levelAllows(level, event.kind) ? 0 : 1,
      );
      if (added.changes > 0) recorded.push(event);
    }
    // Not read again: the update time stays as it was, so a failed read is retried; the re-review seen is kept.
    store.run(
      `INSERT INTO follow_ups (pr_key, repo, number, checked_at, updated_at, state) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (pr_key) DO UPDATE SET checked_at = excluded.checked_at,
         updated_at = ${read ? "excluded.updated_at" : "follow_ups.updated_at"}, state = excluded.state`,
      pr.key,
      pr.repo,
      pr.number,
      now.toISOString(),
      read ? pr.updatedAt : null,
      JSON.stringify(state),
    );
  });
  return recorded;
}

const running = new Map<string, Promise<FollowUpCheckResult>>();

/**
 * Checks the PRs you reviewed for what's new (see the top of this file) and records it. Two calls at once share one
 * run, and a call within `minIntervalMs` of the last check asks GitHub nothing. Never throws for one PR: it's tried
 * again next time. Throws when the request that finds the PRs fails (signed out, offline).
 */
export function checkFollowUps(
  client: GitHubClient,
  store: AldenStore,
  options: FollowUpCheckOptions,
): Promise<FollowUpCheckResult> {
  const already = running.get(store.path);
  if (already) return already;
  const run = runCheck(client, store, options);
  running.set(store.path, run);
  return run.finally(() => running.delete(store.path));
}

async function runCheck(
  client: GitHubClient,
  store: AldenStore,
  options: FollowUpCheckOptions,
): Promise<FollowUpCheckResult> {
  const now = options.now ?? new Date();
  const result: FollowUpCheckResult = { followed: 0, read: 0, failed: 0, ended: 0, recorded: [] };
  const last = store.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", LAST_CHECK_KEY)?.value;
  const interval = options.minIntervalMs ?? FOLLOW_UP_MIN_INTERVAL_MS;
  if (last && now.getTime() - Date.parse(last) < interval && now.getTime() >= Date.parse(last)) {
    return { ...result, skipped: true };
  }

  const since = new Date(now.getTime() - FOLLOW_UP_WINDOW_DAYS * DAY_MS).toISOString();
  // Quiet for the whole window, and no level of its own: no longer followed.
  store.run(
    "DELETE FROM follow_ups WHERE COALESCE(updated_at, checked_at) < ? AND pr_key NOT IN (SELECT pr_key FROM pr_watch)",
    since,
  );
  store.run(
    "DELETE FROM follow_up_events WHERE at < ?",
    new Date(now.getTime() - EVENTS_KEEP_DAYS * DAY_MS).toISOString(),
  );

  const followed = new Map<string, Followed>();
  for (const row of options.queue ?? []) {
    if (!row.followUp) continue;
    const key = prKeyOf(row.pr.repo, row.pr.number);
    followed.set(key, {
      key,
      repo: row.pr.repo,
      number: row.pr.number,
      title: row.pr.title,
      url: row.pr.url,
      author: row.pr.author ?? undefined,
      updatedAt: row.pr.updatedAt,
      rereviewRequestedAt: row.followUp.rereviewRequestedAt,
    });
  }
  const toLookUp = lookups(store, since, new Set(followed.keys()));
  const variables: Record<string, unknown> = { q: followedSearch(now), first: FOLLOW_UP_SEARCH_LIMIT };
  toLookUp.forEach((pr, i) => {
    const [owner, name] = pr.repo.split("/") as [string, string];
    Object.assign(variables, { [`o${i}`]: owner, [`n${i}`]: name, [`k${i}`]: pr.number });
  });
  const data = await graphqlPartial<
    { viewer: { login: string }; search: { nodes: (Partial<RawFollowed> | null)[] } } & Record<string, unknown>
  >(client, followedQuery(toLookUp.length), variables);
  const viewer = data.viewer.login;
  for (const node of data.search?.nodes ?? []) {
    // Search nodes that aren't PRs come back empty.
    if (!node || typeof node.number !== "number") continue;
    const pr = toFollowed(node as RawFollowed);
    if (!followed.has(pr.key)) followed.set(pr.key, pr);
  }
  for (const [i, ref] of toLookUp.entries()) {
    const raw = (data[`p${i}`] as { pullRequest: RawFollowed | null } | null | undefined)?.pullRequest;
    if (raw?.state !== "OPEN") {
      // Merged, closed, or gone (or out of this sign-in's reach): following ends.
      endFollow(store, ref.repo, ref.number);
      result.ended++;
      continue;
    }
    const pr = toFollowed(raw);
    if (!followed.has(pr.key)) followed.set(pr.key, pr);
  }
  result.followed = followed.size;

  const rows = new Map(store.all<FollowRow>("SELECT * FROM follow_ups").map((r) => [r.pr_key, r]));
  const queue = [...followed.values()];
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const pr = queue[next++] as Followed;
      const row = rows.get(pr.key);
      const previous = row ? parseState(row.state) : undefined;
      const moved = !row || !previous || row.updated_at !== pr.updatedAt;
      let threads: ReviewThreads | undefined;
      if (moved) {
        try {
          threads = await fetchReviewThreads(client, pr.repo, pr.number, viewer);
        } catch {
          result.failed++;
          continue;
        }
        if (!threads) {
          endFollow(store, pr.repo, pr.number);
          result.ended++;
          continue;
        }
        result.read++;
      }
      // Without a previous state this read is the baseline, and records nothing that already happened.
      const { state, events } = compareFollowUp(pr, previous, threads, pr.rereviewRequestedAt, now);
      if (!moved && events.length === 0) continue;
      try {
        result.recorded.push(...save(store, pr, state, events, moved, options.global, now));
      } catch {
        result.failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? CONCURRENCY, queue.length) }, worker));
  store.run(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    LAST_CHECK_KEY,
    now.toISOString(),
  );
  return result;
}
