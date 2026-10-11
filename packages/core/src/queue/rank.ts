import {
  type AldenConfig,
  type FastTrackKind,
  type Lane,
  QUEUE_SCHEMA_VERSION,
  type RankedPullRequest,
  type RankedQueue,
  type RankWeight,
  type Score,
  type ScoreLine,
} from "@alden/schema";
import type { PullRequestFacts } from "../github/pull-requests.js";
import type { ReviewQueue } from "../github/queue.js";
import { type Learning, prFeatures, type QueueRow, queueBoost, sensitiveDir } from "../learn/learn.js";
import { fileKind, isLockfile, isPatchBumpTitle, sensitiveMatcher } from "./files.js";
import { followUpOf, REREVIEW_REASON } from "./rereview.js";
import { applyRules } from "./rules.js";

export type { FastTrackKind, Lane, RankedPullRequest, RankedQueue, Score };

/** Labels that mean "someone is blocked on this now". */
const URGENT_LABEL = /\b(hotfix|urgent|critical|blocker|p0|sev[ -]?[01])\b/i;

/**
 * v0 weights. Plain numbers so anyone can see why a PR ranks where it does; tuned by testing on real queues.
 * Waiting counts most: the product exists to stop PRs going stale. Your `[queue.rank]` weights multiply each signal's
 * points on top of these (see RankWeightsSchema for what each signal is worth).
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
  context: { now: number; authorQueueSize: number; learning?: Learning | undefined; viewer?: string },
): RankedPullRequest {
  const reasons: { weight: number; text: string }[] = [];
  const add = (weight: number, text: string) => reasons.push({ weight, text });
  const isSensitive = sensitiveMatcher(config.sensitivePaths);
  const { rules, ...weights } = config.rank;
  const breakdown: ScoreLine[] = [];
  /**
   * A signal's points at your weight for it, on the row as a reason (unless `shown` is false) and in the breakdown.
   * A weight of 0 ignores the signal: no points, no reason.
   */
  const signal = (name: RankWeight, base: number, text: string, shown = true): number => {
    const weight = weights[name];
    if (base === 0 || weight === 0) return 0;
    const points = base * weight;
    breakdown.push({ signal: name, points, ...(weight !== 1 ? { weight } : {}), text });
    if (shown) add(points, text);
    return points;
  };

  // Wait
  const since = Date.parse(pr.request.requestedAt ?? pr.createdAt);
  const waitingHours = Math.max(0, (context.now - since) / 3_600_000);
  const wait = waitingHours < 4 ? 0 : waitingHours < 24 ? 1 : waitingHours < 72 ? 2 : 3;
  const waitPoints = signal("waiting", wait * WEIGHTS.wait, `waiting ${formatAge(waitingHours)}`);

  // Risk
  let risk = 0;
  let riskPoints = 0;
  const { additions, deletions } = reviewableSize(pr);
  const lines = additions + deletions;
  const sizeScore = pr.filesTruncated || lines > 1000 ? 3 : lines > 250 ? 2 : lines > config.fastTrackMaxLines ? 1 : 0;
  risk += sizeScore;
  riskPoints += signal(
    "size",
    sizeScore * WEIGHTS.risk,
    sizeScore >= 2 ? `large (+${additions}/-${deletions})` : `${lines} lines`,
    sizeScore >= 2,
  );

  const sensitive = pr.files.map((f) => f.path).filter(isSensitive);
  if (sensitive.length > 0) {
    risk += 2;
    const dirs = [...new Set(sensitive.map((p) => sensitiveDir(p, isSensitive)))];
    riskPoints += signal(
      "risk",
      2 * WEIGHTS.risk,
      `touches ${dirs.slice(0, 2).join(", ")}${dirs.length > 2 ? ` +${dirs.length - 2}` : ""}`,
    );
  }

  // A major dependency bump can break callers anywhere, however small its diff.
  const bumps = pr.majorBumps ?? [];
  const [bump] = bumps;
  if (bump) {
    risk += 2;
    const more = bumps.length > 1 ? ` +${bumps.length - 1}` : "";
    riskPoints += signal("risk", 2 * WEIGHTS.risk, `major bump: ${bump.name} ${bump.from} → ${bump.to}${more}`);
  }

  const kinds = pr.files.map((f) => fileKind(f.path));
  if (kinds.includes("code") && !kinds.includes("test")) {
    risk += 1;
    riskPoints += signal("noTests", WEIGHTS.risk, "no test changes");
  }

  // Failing CI isn't risk for the reviewer: the author has to fix it first. It leads the reasons and sinks the PR.
  const waitingOnAuthor = pr.ci === "failure";
  if (waitingOnAuthor) add(Number.POSITIVE_INFINITY, `CI failing: ping ${pr.author ? `@${pr.author}` : "the author"}`);

  if (pr.codeownedFiles.length > 0) {
    risk += 1;
    riskPoints += signal(
      "ownsFiles",
      WEIGHTS.risk,
      `you own ${pr.codeownedFiles.length} file${pr.codeownedFiles.length === 1 ? "" : "s"}`,
    );
  }

  // Blocking
  let blocking = 0;
  let blockingPoints = 0;
  const urgent = pr.labels.find((l) => URGENT_LABEL.test(l));
  if (urgent) {
    blocking += 3;
    blockingPoints += signal("urgentLabel", 3 * WEIGHTS.blocking, `labelled ${urgent}`);
  }
  if (pr.stackedPrs > 0) {
    blocking += 2;
    blockingPoints += signal(
      "stacked",
      2 * WEIGHTS.blocking,
      `${pr.stackedPrs} PR${pr.stackedPrs === 1 ? "" : "s"} stacked on it`,
    );
  }
  // A bot with a pile of PRs isn't a teammate waiting on you.
  if (context.authorQueueSize >= 2 && pr.author && !pr.authorIsBot) {
    blocking += 1;
    blockingPoints += signal(
      "sameAuthor",
      WEIGHTS.blocking,
      `@${pr.author} has ${context.authorQueueSize} PRs waiting on you`,
    );
  }

  // You reviewed it and were asked again: someone is waiting on you a second time, usually having acted on what you
  // said, so it sits a little above a first look of the same risk. Needs the viewer: without one there's no "you".
  const followUp = context.viewer === undefined ? undefined : followUpOf(pr, context.viewer);
  if (followUp?.rereviewRequestedAt !== undefined) {
    const points = signal("rereview", WEIGHTS.blocking, REREVIEW_REASON);
    // A weight of 0 switches it off entirely: no points, and not counted as blocking either.
    if (points > 0) blocking += 1;
    blockingPoints += points;
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
    bumps.length === 0 &&
    lines < config.fastTrackMaxLines &&
    blockingSensitive.length === 0 &&
    ciOk &&
    pr.mergeable !== "conflicting" &&
    !pr.isDraft;

  // Your rules come after learning, and learning never overrides them.
  const applied = applyRules(rules, pr, context.viewer);

  // How you treat PRs like this one, from your own history in this repo. Shown, never silent.
  const learned = queueBoost(context.learning, prFeatures(pr, config.sensitivePaths, context.viewer));
  let learnedPoints = 0;
  if (learned.reason) {
    // Learning that pulls against a boost or lower rule is set aside: your rule says how PRs like this rank.
    const opposed = applied.points !== 0 && Math.sign(learned.points) !== Math.sign(applied.points);
    if (opposed) {
      breakdown.push({ signal: "learned", points: 0, text: `${learned.reason} (set aside: your rule decides)` });
    } else {
      learnedPoints = signal("learned", Math.abs(learned.points), learned.reason) * Math.sign(learned.points);
      const line = breakdown.at(-1);
      if (line?.signal === "learned") line.points = learnedPoints;
    }
  }

  // Rule reasons come right after failing CI: they're yours, so they lead.
  for (const text of applied.reasons) add(Number.MAX_VALUE, text);
  breakdown.push(...applied.lines);

  const total = riskPoints + waitPoints + blockingPoints + learnedPoints + applied.points;
  return {
    pr,
    lane: fastTrack ? "fast-track" : "needs-you",
    ...(fastTrack ? { fastTrack: kind } : {}),
    score: {
      risk,
      wait,
      blocking,
      ...(learnedPoints !== 0 ? { learned: learnedPoints } : {}),
      ...(applied.points !== 0 ? { rules: applied.points } : {}),
      total,
    },
    ...(applied.pinned ? { pinned: applied.pinned } : {}),
    breakdown,
    reasons: reasons.sort((a, b) => b.weight - a.weight).map((r) => r.text),
    waitingHours,
    waitingOnAuthor,
    ...(followUp ? { followUp } : {}),
  };
}

/** A first rule's PRs lead their lane and a last rule's trail it, whatever their scores. */
const pinTier = (r: RankedPullRequest) => (r.pinned === "first" ? 0 : r.pinned === "last" ? 2 : 1);

/**
 * "Needs you" order: your first and last rules, then PRs waiting on their author last, then score, then the longest
 * waiting. `learned: false` leaves out what was learned, for learning's own view of where a PR sat.
 */
function byScore(learned: boolean) {
  const score = (r: RankedPullRequest) => r.score.total - (learned ? 0 : (r.score.learned ?? 0));
  return (a: RankedPullRequest, b: RankedPullRequest) =>
    pinTier(a) - pinTier(b) ||
    Number(a.waitingOnAuthor) - Number(b.waitingOnAuthor) ||
    score(b) - score(a) ||
    b.waitingHours - a.waitingHours;
}

/**
 * Splits the queue into "needs you" (highest score first, PRs waiting on their author last) and "fast-track"
 * (longest waiting first), each led by your first rules' PRs and ended by your last rules'. Ranking only orders the
 * queue; nothing is ever approved.
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
      viewer: queue.viewer,
    }),
  );

  const byWait = (a: RankedPullRequest, b: RankedPullRequest) => b.waitingHours - a.waitingHours;
  const pinnedByWait = (a: RankedPullRequest, b: RankedPullRequest) => pinTier(a) - pinTier(b) || byWait(a, b);

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
    needsYou: shown.filter((r) => r.lane === "needs-you").sort(byScore(true)),
    fastTrack: shown.filter((r) => r.lane === "fast-track").sort(pinnedByWait),
    ...(dismissed.length > 0 ? { dismissed } : {}),
    warnings: queue.warnings,
  };
}

/**
 * The queue's rows as learning sees them: each PR's features and its place in "needs you" ranked without anything
 * learned (your weights and rules still count), so opening a PR that learning lifted doesn't count as jumping ahead (which would feed on itself).
 */
export function queueRows(ranked: RankedQueue, config: AldenConfig["queue"]): QueueRow[] {
  const base = [...ranked.needsYou].sort(byScore(false));
  return [...ranked.needsYou, ...ranked.fastTrack, ...(ranked.dismissed ?? [])].map((r) => ({
    url: r.pr.url,
    repo: r.pr.repo,
    number: r.pr.number,
    features: prFeatures(r.pr, config.sensitivePaths, ranked.viewer),
    base: r.lane === "needs-you" && base.includes(r) ? base.indexOf(r) : -1,
    updatedAt: r.pr.updatedAt,
  }));
}
