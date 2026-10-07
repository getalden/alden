import { createHash } from "node:crypto";
import type { ReviewSignal } from "@alden/schema";
import { learningFromReviews } from "../config.js";
import { FeedbackLog } from "../feedback/log.js";
import type { AldenStore } from "../store/db.js";
import type { GitHubClient } from "./client.js";

/**
 * What came of the comments you sent: when a PR's author applies your suggestion or resolves your comment, that's
 * evidence the review was right. Alden remembers where each line comment went (`rememberSentComments`, when a review
 * is sent), then asks GitHub what became of their threads (`checkOutcomes`): one GraphQL request per PR per day at
 * most, for PRs reviewed in the last 14 days, plus one more only when a resolved suggestion needs comparing with the
 * code at the PR's head. Each outcome is recorded once, as a `review_signal` with `source: "outcome"`. Read only:
 * nothing here writes to GitHub.
 */

/** How long after a review its comments are watched. */
export const OUTCOME_WINDOW_DAYS = 14;
/** How long sent comments are kept. */
export const SENT_KEEP_DAYS = 30;
/** How often one PR is asked about, at most. */
export const OUTCOME_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
/** Weights: an applied suggestion counts twice what a resolved comment does. */
export const OUTCOME_WEIGHTS = { applied: 2, resolved: 1 } as const;
/** How many lines either side of a suggestion's place its code is looked for at the head (other edits move it). */
const SEARCH_LINES = 40;
const CONCURRENCY = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

const keyOf = (repo: string, number: number) => `${repo}#${number}`.toLowerCase();

/** A line comment as it was sent, enough to find its thread again. */
export interface SentCommentInput {
  path: string;
  line: number;
  startLine?: number;
  side: "RIGHT" | "LEFT";
  /** The suggested code, when it was a suggestion ('' deletes the lines). */
  suggestion?: string;
  /** The code the comment was on, first line to last: what a suggestion replaces. */
  lines?: string[];
  /** The check of the flagged place it was near, if any. */
  checkId?: string;
}

export interface SentComment extends SentCommentInput {
  rowId: number;
  repo: string;
  number: number;
  reviewId: number;
  headSha: string;
  sentAt: string;
  commentId?: number;
  comparedHead?: string;
  applied: boolean;
  resolved: boolean;
}

interface SentRow {
  id: number;
  repo: string;
  number: number;
  review_id: number;
  head_sha: string;
  sent_at: string;
  path: string;
  line: number;
  start_line: number | null;
  side: string;
  suggestion: string | null;
  lines: string | null;
  check_id: string | null;
  comment_id: number | null;
  compared_head: string | null;
  applied: number;
  resolved: number;
}

function fromRow(row: SentRow): SentComment {
  let lines: string[] | undefined;
  try {
    const parsed = row.lines ? (JSON.parse(row.lines) as unknown) : undefined;
    if (Array.isArray(parsed) && parsed.every((l) => typeof l === "string")) lines = parsed;
  } catch {
    // kept without its lines
  }
  return {
    rowId: Number(row.id),
    repo: row.repo,
    number: Number(row.number),
    reviewId: Number(row.review_id),
    headSha: row.head_sha,
    sentAt: row.sent_at,
    path: row.path,
    line: Number(row.line),
    ...(row.start_line !== null ? { startLine: Number(row.start_line) } : {}),
    side: row.side === "LEFT" ? "LEFT" : "RIGHT",
    ...(row.suggestion !== null ? { suggestion: row.suggestion } : {}),
    ...(lines ? { lines } : {}),
    ...(row.check_id !== null ? { checkId: row.check_id } : {}),
    ...(row.comment_id !== null ? { commentId: Number(row.comment_id) } : {}),
    ...(row.compared_head !== null ? { comparedHead: row.compared_head } : {}),
    applied: Number(row.applied) === 1,
    resolved: Number(row.resolved) === 1,
  };
}

/** Drops sent comments older than `SENT_KEEP_DAYS`, and the check times of PRs with none left. */
export function pruneSentComments(store: AldenStore, now: Date = new Date()): void {
  const cutoff = new Date(now.getTime() - SENT_KEEP_DAYS * DAY_MS).toISOString();
  store.run("DELETE FROM sent_comments WHERE sent_at < ?", cutoff);
  store.run("DELETE FROM outcome_checks WHERE pr_key NOT IN (SELECT pr_key FROM sent_comments)");
}

/**
 * Remembers a sent review's line comments, to see later what came of them. A new review on a PR also starts its
 * checks afresh (a reopened PR is watched again).
 */
export function rememberSentComments(
  store: AldenStore,
  review: { repo: string; number: number; reviewId: number; headSha: string; sentAt: string },
  comments: SentCommentInput[],
): void {
  if (comments.length === 0) return;
  const prKey = keyOf(review.repo, review.number);
  store.transaction(() => {
    for (const c of comments) {
      store.run(
        `INSERT INTO sent_comments (pr_key, repo, number, review_id, head_sha, sent_at, path, line, start_line, side,
           suggestion, lines, check_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        prKey,
        review.repo,
        review.number,
        review.reviewId,
        review.headSha,
        review.sentAt,
        c.path,
        c.line,
        c.startLine ?? null,
        c.side,
        c.suggestion ?? null,
        c.lines ? JSON.stringify(c.lines) : null,
        c.checkId ?? null,
      );
    }
    store.run("DELETE FROM outcome_checks WHERE pr_key = ?", prKey);
  });
  pruneSentComments(store, new Date(review.sentAt));
}

/** A PR's sent comments, oldest first. */
export function sentComments(store: AldenStore, repo: string, number: number): SentComment[] {
  return store
    .all<SentRow>("SELECT * FROM sent_comments WHERE pr_key = ? ORDER BY sent_at, id", keyOf(repo, number))
    .map(fromRow);
}

// --- Asking GitHub ----------------------------------------------------------------------------------------------

/**
 * The one request per PR: its state and head, its latest commits (to tell a push since the review), and its review
 * threads with each thread's first comment, which says which review started it.
 */
export const OUTCOMES_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      headRefOid
      commits(last: 50) { nodes { commit { oid committedDate } } }
      reviewThreads(first: 100) {
        nodes {
          isResolved
          isOutdated
          path
          line
          startLine
          originalLine
          originalStartLine
          diffSide
          comments(first: 1) {
            nodes { databaseId author { login } pullRequestReview { databaseId } }
          }
        }
      }
    }
  }
}`;

export interface OutcomeThread {
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  originalStartLine: number | null;
  diffSide: "LEFT" | "RIGHT";
  comments: {
    nodes: ({
      databaseId: number | null;
      author: { login: string } | null;
      pullRequestReview: { databaseId: number | null } | null;
    } | null)[];
  };
}

export interface OutcomePullRequest {
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefOid: string;
  commits: { nodes: ({ commit: { oid: string; committedDate: string } } | null)[] };
  reviewThreads: { nodes: (OutcomeThread | null)[] };
}

async function fetchOutcomeState(
  client: GitHubClient,
  repo: string,
  number: number,
): Promise<OutcomePullRequest | undefined> {
  const [owner, name] = repo.split("/") as [string, string];
  try {
    const data = await client.graphql<{ repository: { pullRequest: OutcomePullRequest | null } | null }>(
      OUTCOMES_QUERY,
      { owner, name, number },
    );
    return data.repository?.pullRequest ?? undefined;
  } catch (error) {
    // GitHub answers a PR or repo that's gone (or hidden from this sign-in) with a NOT_FOUND error.
    const errors = (error as { errors?: { type?: string }[] }).errors;
    if (errors?.some((e) => e.type === "NOT_FOUND")) return undefined;
    throw error;
  }
}

/** Files at a commit, in one request: text by path, null when missing or not text. */
async function fetchFilesAt(
  client: GitHubClient,
  repo: string,
  oid: string,
  paths: string[],
): Promise<Map<string, string | null>> {
  const [owner, name] = repo.split("/") as [string, string];
  const fields = paths.map(
    (path, i) => `f${i}: object(expression: ${JSON.stringify(`${oid}:${path}`)}) { ... on Blob { text } }`,
  );
  const data = await client.graphql<{ repository: Record<string, { text?: string | null } | null> | null }>(
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(" ")} } }`,
    { owner, name },
  );
  const found = data.repository ?? {};
  return new Map(paths.map((path, i) => [path, found[`f${i}`]?.text ?? null]));
}

// --- Deciding ---------------------------------------------------------------------------------------------------

/** The thread a sent comment started: by its comment's id once known, else by review, file and original lines. */
export function threadOf(comment: SentComment, threads: OutcomeThread[]): OutcomeThread | undefined {
  return threads.find((t) => {
    const first = t.comments.nodes[0];
    if (!first) return false;
    if (comment.commentId !== undefined && first.databaseId !== null) return first.databaseId === comment.commentId;
    return (
      first.pullRequestReview?.databaseId === comment.reviewId &&
      t.path === comment.path &&
      t.originalLine === comment.line &&
      (t.originalStartLine ?? comment.line) === (comment.startLine ?? comment.line) &&
      t.diffSide === comment.side
    );
  });
}

const norm = (line: string) => line.trim();
const splitLines = (text: string) => text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");

/** Where `run` appears in `lines` within [from, to), as a line index; -1 if it doesn't. */
function findRun(lines: string[], run: string[], from: number, to: number): number {
  if (run.length === 0) return -1;
  const start = Math.max(0, from);
  const end = Math.min(lines.length, to) - run.length;
  for (let i = start; i <= end; i++) {
    if (run.every((r, k) => norm(lines[i + k] ?? "") === norm(r))) return i;
  }
  return -1;
}

/**
 * Whether a suggestion's code is now in the file (`text`, at the PR's head) near where it was suggested: its lines,
 * in order, within `SEARCH_LINES` of the place (or of `nearLine`, where GitHub now shows the thread), and, unless the
 * suggestion keeps them, the lines it replaced gone from there. A deletion (an empty suggestion) is applied when the
 * replaced lines are gone. Leading and trailing spaces don't count, so a formatter's re-indent still matches.
 */
export function suggestionApplied(text: string, comment: SentCommentInput, nearLine?: number): boolean {
  if (comment.suggestion === undefined) return false;
  const lines = splitLines(text);
  const suggested = comment.suggestion === "" ? [] : splitLines(comment.suggestion);
  const original = comment.lines;
  const centre = (nearLine ?? comment.startLine ?? comment.line) - 1;
  const from = centre - SEARCH_LINES;
  const to = centre + SEARCH_LINES + Math.max(suggested.length, original?.length ?? 0) + 1;
  const sameAsBefore = original !== undefined && original.map(norm).join("\n") === suggested.map(norm).join("\n");
  if (sameAsBefore) return false;
  const keepsOriginal =
    original !== undefined && original.length > 0 && findRun(suggested, original, 0, suggested.length) >= 0;
  const originalGone = original === undefined || original.length === 0 || findRun(lines, original, from, to) < 0;
  if (suggested.length === 0) return original !== undefined && original.length > 0 && originalGone;
  // Blank lines and lone braces say nothing on their own.
  const telling = suggested.some((l) => norm(l).length >= 3);
  if (!telling) return originalGone && original !== undefined && findRun(lines, suggested, from, to) >= 0;
  return findRun(lines, suggested, from, to) >= 0 && (keepsOriginal || originalGone);
}

export interface OutcomeDecision {
  comment: SentComment;
  signal: "applied" | "resolved";
}

/**
 * Whether a comment's thread is done with: resolved (by anyone), or outdated after a push since the review (GitHub
 * marks a thread outdated when a later commit changed its lines).
 */
function threadDone(comment: SentComment, thread: OutcomeThread, pr: OutcomePullRequest): boolean {
  const pushed =
    pr.headRefOid !== comment.headSha ||
    pr.commits.nodes.some((n) => n !== null && n.commit.committedDate > comment.sentAt);
  return thread.isResolved || (thread.isOutdated && pushed);
}

/** The suggestions whose files need reading at the head to decide: done with, not yet applied, not compared there. */
export function filesToCompare(comments: SentComment[], pr: OutcomePullRequest): string[] {
  const threads = pr.reviewThreads.nodes.filter((t): t is OutcomeThread => t !== null);
  const paths = new Set<string>();
  for (const c of comments) {
    if (c.suggestion === undefined || c.applied || c.comparedHead === pr.headRefOid) continue;
    const thread = threadOf(c, threads);
    if (thread && threadDone(c, thread, pr)) paths.add(c.path);
  }
  return [...paths];
}

/**
 * What came of each sent comment, from its thread: `applied` for a suggestion whose thread is done with (see
 * `threadDone`) and whose code is now at its place in the head (`files`, read for `filesToCompare`), `resolved` for
 * any other comment whose thread is done with. Each at most once: never `resolved` after `applied`, though a
 * suggestion first resolved and applied later gets both.
 */
export function decideOutcomes(
  comments: SentComment[],
  pr: OutcomePullRequest,
  files: Map<string, string | null> = new Map(),
): OutcomeDecision[] {
  const threads = pr.reviewThreads.nodes.filter((t): t is OutcomeThread => t !== null);
  const out: OutcomeDecision[] = [];
  for (const comment of comments) {
    if (comment.applied) continue;
    const thread = threadOf(comment, threads);
    if (!thread || !threadDone(comment, thread, pr)) continue;
    const text = files.get(comment.path);
    if (
      comment.suggestion !== undefined &&
      typeof text === "string" &&
      suggestionApplied(text, comment, thread.line ?? undefined)
    ) {
      out.push({ comment, signal: "applied" });
    } else if (!comment.resolved) {
      out.push({ comment, signal: "resolved" });
    }
  }
  return out;
}

/** The signal an outcome is recorded as. */
export function outcomeSignal(decision: OutcomeDecision, now: Date): ReviewSignal {
  const { comment, signal } = decision;
  return {
    type: "review_signal",
    repo: comment.repo,
    pr: comment.number,
    at: now.toISOString(),
    signal,
    ...(comment.checkId !== undefined ? { checkId: comment.checkId } : {}),
    path: comment.path,
    line: comment.line,
    weight: OUTCOME_WEIGHTS[signal],
    source: "outcome",
  };
}

/** The event id an outcome gets: one per comment and signal, so it's recorded once. */
export function outcomeId(decision: OutcomeDecision): string {
  const c = decision.comment;
  const key = [keyOf(c.repo, c.number), c.reviewId, c.path, c.startLine ?? "", c.line, c.side, decision.signal].join(
    "|",
  );
  return `outcome-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

// --- Running ----------------------------------------------------------------------------------------------------

export interface OutcomeCheckResult {
  /** PRs asked about. */
  checked: number;
  /** PRs that failed (left for tomorrow). */
  failed: number;
  /** Outcomes newly recorded. */
  recorded: ReviewSignal[];
}

/** The PRs due a check: a review sent in the window, not checked in the last day, not already checked after close. */
export function duePullRequests(store: AldenStore, now: Date = new Date()): { repo: string; number: number }[] {
  const since = new Date(now.getTime() - OUTCOME_WINDOW_DAYS * DAY_MS).toISOString();
  const checkedSince = new Date(now.getTime() - OUTCOME_CHECK_EVERY_MS).toISOString();
  return store.all<{ repo: string; number: number }>(
    `SELECT s.repo AS repo, s.number AS number FROM sent_comments s
       LEFT JOIN outcome_checks c ON c.pr_key = s.pr_key
     WHERE s.sent_at >= ? AND (c.pr_key IS NULL OR (c.closed = 0 AND c.checked_at < ?))
     GROUP BY s.pr_key ORDER BY MAX(s.sent_at) DESC, s.pr_key`,
    since,
    checkedSince,
  );
}

async function checkPullRequest(
  client: GitHubClient,
  store: AldenStore,
  log: FeedbackLog,
  pr: { repo: string; number: number },
  now: Date,
): Promise<ReviewSignal[]> {
  const state = await fetchOutcomeState(client, pr.repo, pr.number);
  const prKey = keyOf(pr.repo, pr.number);
  const markChecked = (head: string | null, closed: boolean) =>
    store.run(
      "INSERT OR REPLACE INTO outcome_checks (pr_key, checked_at, head_sha, closed) VALUES (?, ?, ?, ?)",
      prKey,
      now.toISOString(),
      head,
      closed ? 1 : 0,
    );
  if (!state) {
    // Gone, or out of this sign-in's reach: nothing more to learn.
    markChecked(null, true);
    return [];
  }
  const comments = sentComments(store, pr.repo, pr.number);
  const paths = filesToCompare(comments, state);
  const files = paths.length > 0 ? await fetchFilesAt(client, pr.repo, state.headRefOid, paths) : new Map();
  const decisions = decideOutcomes(comments, state, files);
  const threads = state.reviewThreads.nodes.filter((t): t is OutcomeThread => t !== null);
  const recorded: ReviewSignal[] = [];
  store.transaction(() => {
    for (const c of comments) {
      const commentId = threadOf(c, threads)?.comments.nodes[0]?.databaseId;
      if (commentId != null && c.commentId === undefined) {
        store.run("UPDATE sent_comments SET comment_id = ? WHERE id = ?", commentId, c.rowId);
      }
      if (paths.includes(c.path) && c.suggestion !== undefined) {
        store.run("UPDATE sent_comments SET compared_head = ? WHERE id = ?", state.headRefOid, c.rowId);
      }
    }
    for (const decision of decisions) {
      const signal = outcomeSignal(decision, now);
      if (log.recordSignal(signal, outcomeId(decision))) recorded.push(signal);
      store.run(
        decision.signal === "applied"
          ? "UPDATE sent_comments SET applied = 1, resolved = 1 WHERE id = ?"
          : "UPDATE sent_comments SET resolved = 1 WHERE id = ?",
        decision.comment.rowId,
      );
    }
    markChecked(state.headRefOid, state.state !== "OPEN");
  });
  return recorded;
}

const running = new Map<string, Promise<OutcomeCheckResult>>();

/**
 * Asks GitHub what came of the comments you sent, for each PR due a check (see `duePullRequests`), a few at a time,
 * and records the outcomes. A PR that fails is marked checked anyway, so a bad day costs one request, not one per
 * refresh. Never throws for one PR; two calls at once share one run. Does nothing when `learning.fromReviews` is off.
 */
export function checkOutcomes(
  client: GitHubClient,
  store: AldenStore,
  options: { now?: Date; concurrency?: number } = {},
): Promise<OutcomeCheckResult> {
  const already = running.get(store.path);
  if (already) return already;
  const run = (async (): Promise<OutcomeCheckResult> => {
    const result: OutcomeCheckResult = { checked: 0, failed: 0, recorded: [] };
    if (!(await learningFromReviews())) return result;
    const now = options.now ?? new Date();
    pruneSentComments(store, now);
    const due = duePullRequests(store, now);
    const log = new FeedbackLog(store);
    let next = 0;
    const worker = async () => {
      while (next < due.length) {
        const pr = due[next++] as { repo: string; number: number };
        try {
          result.recorded.push(...(await checkPullRequest(client, store, log, pr, now)));
          result.checked++;
        } catch {
          result.failed++;
          try {
            store.run(
              `INSERT INTO outcome_checks (pr_key, checked_at, closed) VALUES (?, ?, 0)
               ON CONFLICT (pr_key) DO UPDATE SET checked_at = excluded.checked_at`,
              keyOf(pr.repo, pr.number),
              now.toISOString(),
            );
          } catch {
            // the next run tries again
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency ?? CONCURRENCY, due.length) }, worker));
    return result;
  })();
  running.set(store.path, run);
  return run.finally(() => running.delete(store.path));
}

// --- Showing ----------------------------------------------------------------------------------------------------

export interface OutcomeSummary {
  applied: number;
  resolved: number;
  /** PRs whose comments are being watched. */
  watching: number;
  days: number;
}

/** Outcomes recorded in the last `OUTCOME_WINDOW_DAYS`, and how many PRs are watched. */
export function outcomeSummary(store: AldenStore, now: Date = new Date()): OutcomeSummary {
  const since = new Date(now.getTime() - OUTCOME_WINDOW_DAYS * DAY_MS).toISOString();
  const signals = new FeedbackLog(store).signals({ since }).filter((s) => s.source === "outcome");
  const watching =
    store.get<{ n: number }>("SELECT COUNT(DISTINCT pr_key) AS n FROM sent_comments WHERE sent_at >= ?", since)?.n ?? 0;
  return {
    applied: signals.filter((s) => s.signal === "applied").length,
    resolved: signals.filter((s) => s.signal === "resolved").length,
    watching: Number(watching),
    days: OUTCOME_WINDOW_DAYS,
  };
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Outcomes: 3 suggestions applied, 2 comments resolved (last 14 days)", or undefined with nothing to say. */
export function outcomeLine(summary: OutcomeSummary): string | undefined {
  if (summary.applied + summary.resolved === 0 && summary.watching === 0) return undefined;
  return `Outcomes: ${count(summary.applied, "suggestion", "suggestions")} applied, ${count(summary.resolved, "comment", "comments")} resolved (last ${summary.days} days)`;
}
