import type { BriefingLearning, CheckResult, Evidence, LookHere, Severity } from "@alden/schema";
import { checkLesson, checkReason, dismissKey, type Learning, quietenedReason } from "../learn/learn.js";
import { fileKind, isLockfile } from "../queue/files.js";

/** How many places "Needs your eyes" holds unless `review.eyes` says otherwise, and the most it can be set to. */
export const MAX_LOOK_HERE = 3;
export const MOST_LOOK_HERE = 10;

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/** High and critical flags are never left out because of feedback. */
export const isSevere = (severity: Severity) => severity === "high" || severity === "critical";

/** Among equal severities, what a reviewer should see first. */
const CHECK_PRIORITY = [
  "secrets.likely",
  "injection.ai",
  "migrations.changed",
  "callers.outside",
  "signatures.changed",
  "dependencies.changed",
  "tests.missing",
  "config.changed",
  "paths.sensitive",
];

/**
 * Not places to look: failing CI is the author's move (the queue already says "ping @author"), so it never takes
 * one of the slots.
 */
const NOT_A_PLACE = new Set(["ci.status"]);

const TITLES: Record<string, (path: string) => string> = {
  "secrets.likely": (p) => `Possible secret in ${p}`,
  "injection.ai": (p) => `Text aimed at AI reviewers in ${p}`,
  "migrations.changed": (p) => `Migration in ${p}`,
  "signatures.changed": (p) => `Public API change in ${p}`,
  "callers.outside": (p) => `Caller of changed code in ${p}`,
  "dependencies.changed": (p) => `Dependency changes in ${p}`,
  "tests.missing": (p) => `Untested change in ${p}`,
  "config.changed": (p) => `Config change in ${p}`,
  "paths.sensitive": (p) => `Sensitive file ${p}`,
};

/**
 * A file that still imports a moved or deleted module by its old path isn't calling changed code: it's importing a
 * path that's gone. The callers check words that evidence "imports <old path> (moved to …|deleted)".
 */
const isOldImport = (check: CheckResult, evidence: Evidence) =>
  check.id === "callers.outside" && evidence.text.startsWith("imports ");

/** Checks whose evidence without a file can still take a place, and its title. */
const PLACELESS: Record<string, (text: string) => string> = {
  "injection.ai": (text) =>
    `Text aimed at AI reviewers in the PR ${text.startsWith("PR title") ? "title" : "description"}`,
};

type Anchored = Evidence & { anchor: NonNullable<Evidence["anchor"]> };

/**
 * The few places a human should look, from the flagged checks: most severe first, at most one per file, at most
 * three. Each flagged check gets a slot before any check gets a second, so one noisy check can't crowd out the
 * rest; a file flagged by two checks takes one slot, and so does a directory of similar flags (except secrets). A
 * low-severity check gets one slot at most: it's worth a look, not the whole list. Places in code come before places in
 * tests, and a caller in a test file never takes one.
 */
export function pickLookHere(checks: CheckResult[], adjust: PickAdjustments = {}): LookHere[] {
  const preferred = (id: string) => (adjust.prefer?.(id) ? 0 : 1);
  const flagged = checks
    .filter((c) => c.status === "flagged" && !NOT_A_PLACE.has(c.id))
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        preferred(a.id) - preferred(b.id) ||
        rank(a.id) - rank(b.id),
    );

  const picked: LookHere[] = [];
  const usedPaths = new Set<string>();
  const usedDirs = new Set<string>();
  const usedPlaceless = new Set<string>();
  const take = (check: CheckResult): boolean => {
    // Text aimed at AI reviewers in the PR's title or description has no file, but is still a place to read.
    if (PLACELESS[check.id]) {
      const loose = check.evidence.find(
        (e) =>
          !e.anchor &&
          !usedPlaceless.has(e.text) &&
          !adjust.skip?.(check, PLACELESS[check.id]?.(e.text) ?? check.title, ""),
      );
      if (loose) {
        usedPlaceless.add(loose.text);
        const learned = adjust.why?.(check.id);
        picked.push({
          title: PLACELESS[check.id]?.(loose.text) ?? check.title,
          reason: `${loose.text}. ${check.summary}`,
          checkId: check.id,
          ...(learned ? { learned } : {}),
        });
        return true;
      }
    }
    const isSecret = check.id === "secrets.likely";
    const usable = check.evidence.filter(
      (e): e is Anchored =>
        e.anchor !== undefined &&
        !adjust.skip?.(check, titleOf(check, e as Anchored), e.anchor.path) &&
        !usedPaths.has(e.anchor.path) &&
        // Nobody reads a lockfile line by line; what changed in it is the dependency check's job.
        (isSecret || !isLockfile(e.anchor.path)) &&
        // One slot per directory, so ten near-identical workflow files don't fill the list. Each secret still counts.
        (isSecret || !usedDirs.has(dirOf(e.anchor.path))),
    );
    // Code before tests: a caller in views.py matters more than one in test_pricing.py. Test callers stay in the
    // check's evidence but never take a place; other checks fall back to a test file when that's all they flagged.
    const isTest = (e: Anchored) => fileKind(e.anchor.path) === "test";
    const evidence = usable.find((e) => !isTest(e)) ?? (check.id === "callers.outside" ? undefined : usable[0]);
    if (!evidence) return false;
    usedPaths.add(evidence.anchor.path);
    if (!isSecret && dirOf(evidence.anchor.path) !== "") usedDirs.add(dirOf(evidence.anchor.path));
    const title = titleOf(check, evidence);
    const learned = adjust.why?.(check.id);
    picked.push({
      title,
      reason: `${evidence.text}. ${check.summary}`,
      anchor: evidence.anchor,
      checkId: check.id,
      ...(learned ? { learned } : {}),
    });
    return true;
  };

  // Round-robin in severity order until enough are picked or nothing new can be taken.
  const limit = adjust.max ?? MAX_LOOK_HERE;
  let progress = true;
  while (picked.length < limit && progress) {
    progress = false;
    for (const check of flagged) {
      if (picked.length >= limit) break;
      if (check.severity === "low" && picked.some((p) => p.checkId === check.id)) continue;
      if (take(check)) progress = true;
    }
  }

  // Say when a slot stands for a whole directory of flagged files.
  const flaggedPaths = new Set(flagged.flatMap((c) => c.evidence.flatMap((e) => (e.anchor ? [e.anchor.path] : []))));
  return picked.map((item) => {
    const dir = item.anchor && item.checkId !== "secrets.likely" ? dirOf(item.anchor.path) : "";
    const others = dir ? [...flaggedPaths].filter((p) => p !== item.anchor?.path && dirOf(p) === dir) : [];
    return others.length > 0 ? { ...item, reason: `${item.reason} Other files in ${dir} are flagged too.` } : item;
  });
}

function titleOf(check: CheckResult, evidence: Anchored): string {
  const path = evidence.anchor.path;
  if (isOldImport(check, evidence)) return `Still imports the old path in ${path}`;
  return TITLES[check.id]?.(path) ?? `${check.title}: ${path}`;
}

/** How learning changes the pick: places to leave out, checks to take first, and why. */
export interface PickAdjustments {
  skip?: (check: CheckResult, title: string, path: string) => boolean;
  prefer?: (checkId: string) => boolean;
  why?: (checkId: string) => string | undefined;
  /** How many places to pick (`review.eyes`); MAX_LOOK_HERE when unset. */
  max?: number;
}

/**
 * The places to look, with what you've taught Alden: a flag you dismissed on this PR stays down on a re-review, a
 * check you usually mark not useful gives up its slots (never a high or critical one), and a check you usually mark
 * useful goes first among equals. What learning left out is returned as hidden, and the flagged checks it quietened
 * as quietened, so the briefing can say so in both places.
 */
export function pickWithLearning(
  checks: CheckResult[],
  learning: Learning | undefined,
  target: string,
  max: number = MAX_LOOK_HERE,
): { eyes: LookHere[]; hidden: BriefingLearning["hidden"]; quietened: NonNullable<BriefingLearning["quietened"]> } {
  if (!learning) return { eyes: pickLookHere(checks, { max }), hidden: [], quietened: [] };
  const hiddenWhy = (check: CheckResult, title: string, path: string): string | undefined => {
    const at = learning.dismissed.get(
      dismissKey(target, { source: "check", checkId: check.id, title, anchor: { path } }),
    );
    if (at) return `You dismissed it on ${at.slice(0, 10)}`;
    const lesson = checkLesson(learning, check.id);
    if (lesson?.direction === "down" && !isSevere(check.severity)) return checkReason(lesson);
    return undefined;
  };
  const eyes = pickLookHere(checks, {
    max,
    skip: (check, title, path) => hiddenWhy(check, title, path) !== undefined,
    prefer: (id) => checkLesson(learning, id)?.direction === "up",
    why: (id) => {
      const lesson = checkLesson(learning, id);
      return lesson?.direction === "up" ? checkReason(lesson) : undefined;
    },
  });
  const shown = new Set(eyes.map((e) => `${e.checkId}|${e.anchor?.path}`));
  const hidden = pickLookHere(checks, { max }).flatMap((item) => {
    const check = checks.find((c) => c.id === item.checkId);
    if (!check || !item.anchor || shown.has(`${item.checkId}|${item.anchor.path}`)) return [];
    const reason = hiddenWhy(check, item.title, item.anchor.path);
    return reason ? [{ title: item.title, reason, anchor: item.anchor }] : [];
  });
  const quietened = checks.flatMap((check) => {
    const lesson = checkLesson(learning, check.id);
    return check.status === "flagged" && lesson?.direction === "down" && !isSevere(check.severity)
      ? [{ checkId: check.id, reason: quietenedReason(lesson) }]
      : [];
  });
  return { eyes, hidden, quietened };
}

/** "a/b/c.ts" → "a/b/"; root-level files have no directory ("") and never share a slot limit. */
function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash + 1);
}

function rank(id: string): number {
  const i = CHECK_PRIORITY.indexOf(id);
  return i === -1 ? CHECK_PRIORITY.length : i;
}
