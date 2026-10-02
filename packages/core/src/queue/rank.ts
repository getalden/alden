import {
  type AldenConfig,
  type FastTrackKind,
  type Lane,
  QUEUE_SCHEMA_VERSION,
  type RankedPullRequest,
  type RankedQueue,
  type Score,
} from "@alden/schema";
import type { PullRequestFacts } from "../github/pull-requests.js";
import type { ReviewQueue } from "../github/queue.js";
import { type Learning, prFeatures, type QueueRow, queueBoost, sensitiveDir } from "../learn/learn.js";
import { fileKind, isLockfile, isPatchBumpTitle, sensitiveMatcher } from "./files.js";

export type { FastTrackKind, Lane, RankedPullRequest, RankedQueue, Score };

/** Labels that mean "someone is blocked on this now". */
const URGENT_LABEL = /\b(hotfix|urgent|critical|blocker|p0|sev[ -]?[01])\b/i;

/**
 * v0 weights. Plain numbers so anyone can see why a PR ranks where it does; tuned by testing on real queues.
 * Waiting counts most: the product exists to stop PRs going stale.
 */
const WEIGHTS = { risk: 1, wait: 1.5, blocking: 2 };

export function formatAge(hours: number): string {
  if (hours < 1) return "<1h";
  if (hours < 48) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Lines a reviewer actually reads: everything except lockfiles, unless the file list was cut short. */
export function reviewableSize(pr: PullRequestFacts): { additions: number; deletions: number } {
  if (pr.filesTruncated) return { additions: pr.additions, deletions: pr.deletions };
  const counted = pr.files.filter((f) => !isLockfile(f.path));
  return {
    additions: counted.reduce((sum, f) => sum + f.additions, 0),
    deletions: counted.reduce((sum, f) => sum + f.deletions, 0),
  };
}

function fastTrackKind(pr: PullRequestFacts): FastTrackKind | undefined {
  if (pr.files.length === 0 || pr.filesTruncated) return undefined;
  const kinds = new Set(pr.files.map((f) => fileKind(f.path)));
  if (kinds.size === 1 && kinds.has("docs")) return "docs only";
  if (kinds.size === 1 && kinds.has("test")) return "tests only";
  if ([...kinds].every((k) => k === "dependency") && isPatchBumpTitle(pr.title)) return "dependency patch bump";
  return undefined;
}

export function rankPullRequest(
  pr: PullRequestFacts,
  config: AldenConfig["queue"],
  context: { now: number; authorQueueSize: number; learning?: Learning | undefined },
): RankedPullRequest {
  const reasons: { weight: number; text: string }[] = [];
  const add = (weight: number, text: string) => reasons.push({ weight, text });
  const isSensitive = sensitiveMatcher(config.sensitivePaths);

  // Wait
  const since = Date.parse(pr.request.requestedAt ?? pr.createdAt);
  const waitingHours = Math.max(0, (context.now - since) / 3_600_000);
  const wait = waitingHours < 4 ? 0 : waitingHours < 24 ? 1 : waitingHours < 72 ? 2 : 3;
  if (wait > 0) add(wait * WEIGHTS.wait, `waiting ${formatAge(waitingHours)}`);

  // Risk
  let risk = 0;
  const { additions, deletions } = reviewableSize(pr);
  const lines = additions + deletions;
  const sizeScore = pr.filesTruncated || lines > 1000 ? 3 : lines > 250 ? 2 : lines > config.fastTrackMaxLines ? 1 : 0;
  risk += sizeScore;
  if (sizeScore >= 2) add(sizeScore * WEIGHTS.risk, `large (+${additions}/-${deletions})`);

  const sensitive = pr.files.map((f) => f.path).filter(isSensitive);
  if (sensitive.length > 0) {
    risk += 2;
    const dirs = [...new Set(sensitive.map((p) => sensitiveDir(p, isSensitive)))];
    add(2 * WEIGHTS.risk, `touches ${dirs.slice(0, 2).join(", ")}${dirs.length > 2 ? ` +${dirs.length - 2}` : ""}`);
  }

  const kinds = pr.files.map((f) => fileKind(f.path));
  if (kinds.includes("code") && !kinds.includes("test")) {
    risk += 1;
    add(WEIGHTS.risk, "no test changes");
  }

  // Failing CI isn't risk for the reviewer: the author has to fix it first. It leads the reasons and sinks the PR.
  const waitingOnAuthor = pr.ci === "failure";
  if (waitingOnAuthor) add(Number.POSITIVE_INFINITY, `CI failing: ping ${pr.author ? `@${pr.author}` : "the author"}`);

  if (pr.codeownedFiles.length > 0) {
    risk += 1;
    add(WEIGHTS.risk, `you own ${pr.codeownedFiles.length} file${pr.codeownedFiles.length === 1 ? "" : "s"}`);
  }

  // Blocking
  let blocking = 0;
  const urgent = pr.labels.find((l) => URGENT_LABEL.test(l));
  if (urgent) {
    blocking += 3;
    add(3 * WEIGHTS.blocking, `labelled ${urgent}`);
  }
  if (pr.stackedPrs > 0) {
    blocking += 2;
    add(2 * WEIGHTS.blocking, `${pr.stackedPrs} PR${pr.stackedPrs === 1 ? "" : "s"} stacked on it`);
  }
  // A bot with a pile of PRs isn't a teammate waiting on you.
  if (context.authorQueueSize >= 2 && pr.author && !pr.authorIsBot) {
    blocking += 1;
    add(WEIGHTS.blocking, `@${pr.author} has ${context.authorQueueSize} PRs waiting on you`);
  }

  // Facts worth showing that don't change the score.
  if (pr.mergeable === "conflicting") add(0, "has conflicts");
  if (pr.isDraft) add(0, "draft");

  const kind = fastTrackKind(pr);
  // Lockfiles are sensitive by default, but a patch bump is nothing but lockfile and manifest changes.
  const blockingSensitive =
    kind === "dependency patch bump" ? sensitive.filter((p) => fileKind(p) !== "dependency") : sensitive;
  // Green CI, or no CI at all for docs: nothing can break. Tests and bumps with no CI have nothing proving they work.
  const ciOk = pr.ci === "success" || (pr.ci === "none" && kind === "docs only");
  const fastTrack =
    kind !== undefined &&
    lines < config.fastTrackMaxLines &&
    blockingSensitive.length === 0 &&
    ciOk &&
    pr.mergeable !== "conflicting" &&
    !pr.isDraft;

  // How you treat PRs like this one, from your own history in this repo. Shown, never silent.
  const learned = queueBoost(context.learning, prFeatures(pr, config.sensitivePaths));
  if (learned.reason) add(Math.abs(learned.points), learned.reason);

  const total = risk * WEIGHTS.risk + wait * WEIGHTS.wait + blocking * WEIGHTS.blocking + learned.points;
  return {
    pr,
    lane: fastTrack ? "fast-track" : "needs-you",
    ...(fastTrack ? { fastTrack: kind } : {}),
    score: { risk, wait, blocking, ...(learned.points !== 0 ? { learned: learned.points } : {}), total },
    reasons: reasons.sort((a, b) => b.weight - a.weight).map((r) => r.text),
    waitingHours,
    waitingOnAuthor,
  };
}

/**
 * Splits the queue into "needs you" (highest score first, PRs waiting on their author last) and "fast-track"
 * (longest waiting first). Ranking only orders the queue; nothing is ever approved.
 */
export function rankQueue(
  queue: ReviewQueue,
  config: AldenConfig["queue"],
  now: number = Date.now(),
  learning: (repo: string) => Learning | undefined = () => undefined,
): RankedQueue {
  const perAuthor = new Map<string, number>();
  for (const pr of queue.pullRequests) {
    if (pr.author && !pr.authorIsBot) perAuthor.set(pr.author, (perAuthor.get(pr.author) ?? 0) + 1);
  }

  const ranked = queue.pullRequests.map((pr) =>
    rankPullRequest(pr, config, {
      now,
      authorQueueSize: pr.author ? (perAuthor.get(pr.author) ?? 0) : 0,
      learning: learning(pr.repo),
    }),
  );

  const byScore = (a: RankedPullRequest, b: RankedPullRequest) =>
    Number(a.waitingOnAuthor) - Number(b.waitingOnAuthor) ||
    b.score.total - a.score.total ||
    b.waitingHours - a.waitingHours;
  const byWait = (a: RankedPullRequest, b: RankedPullRequest) => b.waitingHours - a.waitingHours;

  // PRs you dismissed stay out of both lanes until they change.
  const isDismissed = (r: RankedPullRequest) => {
    const at = learning(r.pr.repo)?.dismissedPrs.get(`${r.pr.repo.toLowerCase()}#${r.pr.number}`);
    return at !== undefined && at >= r.pr.updatedAt;
  };
  const shown = ranked.filter((r) => !isDismissed(r));
  const dismissed = ranked.filter(isDismissed).sort(byWait);
  return {
    schemaVersion: QUEUE_SCHEMA_VERSION,
    viewer: queue.viewer,
    fetchedAt: queue.fetchedAt,
    needsYou: shown.filter((r) => r.lane === "needs-you").sort(byScore),
    fastTrack: shown.filter((r) => r.lane === "fast-track").sort(byWait),
    ...(dismissed.length > 0 ? { dismissed } : {}),
    warnings: queue.warnings,
  };
}

/**
 * The queue's rows as learning sees them: each PR's features and its place in "needs you" ranked without anything
 * learned, so opening a PR that learning lifted doesn't count as jumping ahead (which would feed on itself).
 */
export function queueRows(ranked: RankedQueue, config: AldenConfig["queue"]): QueueRow[] {
  const base = [...ranked.needsYou].sort(
    (a, b) =>
      Number(a.waitingOnAuthor) - Number(b.waitingOnAuthor) ||
      b.score.total - (b.score.learned ?? 0) - (a.score.total - (a.score.learned ?? 0)) ||
      b.waitingHours - a.waitingHours,
  );
  return [...ranked.needsYou, ...ranked.fastTrack, ...(ranked.dismissed ?? [])].map((r) => ({
    url: r.pr.url,
    repo: r.pr.repo,
    number: r.pr.number,
    features: prFeatures(r.pr, config.sensitivePaths),
    base: r.lane === "needs-you" && base.includes(r) ? base.indexOf(r) : -1,
    updatedAt: r.pr.updatedAt,
  }));
}
