import type { AldenConfig } from "@alden/schema";
import type { PullRequestFacts } from "../github/pull-requests.js";
import type { ReviewQueue } from "../github/queue.js";
import { fileKind, isPatchBumpTitle, sensitiveMatcher } from "./files.js";

export type Lane = "needs-you" | "fast-track";
export type FastTrackKind = "docs only" | "tests only" | "dependency patch bump";

export interface Score {
  risk: number;
  wait: number;
  blocking: number;
  total: number;
}

export interface RankedPullRequest {
  pr: PullRequestFacts;
  lane: Lane;
  /** Why it qualified for fast-track. Only set in that lane. */
  fastTrack?: FastTrackKind;
  score: Score;
  /** Short, human reasons in order of weight, e.g. "waiting 3d", "touches migrations/", "no test changes". */
  reasons: string[];
  /** Hours since the viewer was asked (or since the PR opened, if GitHub didn't say). */
  waitingHours: number;
  /** CI is failing, so the next move is the author's. These sink below every other "needs you" PR. */
  waitingOnAuthor: boolean;
}

export interface RankedQueue {
  viewer: string;
  fetchedAt: string;
  needsYou: RankedPullRequest[];
  fastTrack: RankedPullRequest[];
  warnings: string[];
}

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

function topDir(path: string, matches: (p: string) => boolean): string {
  // Name the shortest leading directory that is itself sensitive, e.g. "db/migrations/" not the full file path.
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const dir = `${parts.slice(0, i).join("/")}/`;
    if (matches(`${dir}x`)) return dir;
  }
  return path;
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
  context: { now: number; authorQueueSize: number },
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
  const lines = pr.additions + pr.deletions;
  const sizeScore = pr.filesTruncated || lines > 1000 ? 3 : lines > 250 ? 2 : lines > config.fastTrackMaxLines ? 1 : 0;
  risk += sizeScore;
  if (sizeScore >= 2) add(sizeScore * WEIGHTS.risk, `large (+${pr.additions}/-${pr.deletions})`);

  const sensitive = pr.files.map((f) => f.path).filter(isSensitive);
  if (sensitive.length > 0) {
    risk += 2;
    const dirs = [...new Set(sensitive.map((p) => topDir(p, isSensitive)))];
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
  if (context.authorQueueSize >= 2 && pr.author) {
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
  const fastTrack =
    kind !== undefined &&
    lines < config.fastTrackMaxLines &&
    blockingSensitive.length === 0 &&
    pr.ci === "success" &&
    pr.mergeable !== "conflicting" &&
    !pr.isDraft;

  const total = risk * WEIGHTS.risk + wait * WEIGHTS.wait + blocking * WEIGHTS.blocking;
  return {
    pr,
    lane: fastTrack ? "fast-track" : "needs-you",
    ...(fastTrack ? { fastTrack: kind } : {}),
    score: { risk, wait, blocking, total },
    reasons: reasons.sort((a, b) => b.weight - a.weight).map((r) => r.text),
    waitingHours,
    waitingOnAuthor,
  };
}

/**
 * Splits the queue into "needs you" (highest score first, PRs waiting on their author last) and "fast-track"
 * (longest waiting first). Ranking only orders the queue; nothing is ever approved.
 */
export function rankQueue(queue: ReviewQueue, config: AldenConfig["queue"], now: number = Date.now()): RankedQueue {
  const perAuthor = new Map<string, number>();
  for (const pr of queue.pullRequests) {
    if (pr.author) perAuthor.set(pr.author, (perAuthor.get(pr.author) ?? 0) + 1);
  }

  const ranked = queue.pullRequests.map((pr) =>
    rankPullRequest(pr, config, { now, authorQueueSize: pr.author ? (perAuthor.get(pr.author) ?? 0) : 0 }),
  );

  const byScore = (a: RankedPullRequest, b: RankedPullRequest) =>
    Number(a.waitingOnAuthor) - Number(b.waitingOnAuthor) ||
    b.score.total - a.score.total ||
    b.waitingHours - a.waitingHours;
  const byWait = (a: RankedPullRequest, b: RankedPullRequest) => b.waitingHours - a.waitingHours;

  return {
    viewer: queue.viewer,
    fetchedAt: queue.fetchedAt,
    needsYou: ranked.filter((r) => r.lane === "needs-you").sort(byScore),
    fastTrack: ranked.filter((r) => r.lane === "fast-track").sort(byWait),
    warnings: queue.warnings,
  };
}
