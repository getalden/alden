import type { BriefingLearning, CheckResult, Evidence, LookHere, Severity } from "@alden/schema";
import { checkReason, dismissKey, type Learning } from "../learn/learn.js";
import { isLockfile } from "../queue/files.js";

export const MAX_LOOK_HERE = 3;

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1, info: 0 };

/** Among equal severities, what a reviewer should see first. */
const CHECK_PRIORITY = [
  "secrets.likely",
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
 * one of the three slots.
 */
const NOT_A_PLACE = new Set(["ci.status"]);

const TITLES: Record<string, (path: string) => string> = {
  "secrets.likely": (p) => `Possible secret in ${p}`,
  "migrations.changed": (p) => `Migration in ${p}`,
  "signatures.changed": (p) => `Public API change in ${p}`,
  "callers.outside": (p) => `Caller of changed code in ${p}`,
  "dependencies.changed": (p) => `Dependency changes in ${p}`,
  "tests.missing": (p) => `Untested change in ${p}`,
  "config.changed": (p) => `Config change in ${p}`,
  "paths.sensitive": (p) => `Sensitive file ${p}`,
};

type Anchored = Evidence & { anchor: NonNullable<Evidence["anchor"]> };

/**
 * The few places a human should look, from the flagged checks: most severe first, at most one per file, at most
 * three. Each flagged check gets a slot before any check gets a second, so one noisy check can't crowd out the
 * rest; a file flagged by two checks takes one slot, and so does a directory of similar flags (except secrets). A
 * low-severity check gets one slot at most: it's worth a look, not the whole list.
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
  const take = (check: CheckResult): boolean => {
    const isSecret = check.id === "secrets.likely";
    const evidence = check.evidence.find(
      (e): e is Anchored =>
        e.anchor !== undefined &&
        !adjust.skip?.(check, titleOf(check, e.anchor.path), e.anchor.path) &&
        !usedPaths.has(e.anchor.path) &&
        // Nobody reads a lockfile line by line; what changed in it is the dependency check's job.
        (isSecret || !isLockfile(e.anchor.path)) &&
        // One slot per directory, so ten near-identical workflow files don't fill the list. Each secret still counts.
        (isSecret || !usedDirs.has(dirOf(e.anchor.path))),
    );
    if (!evidence) return false;
    usedPaths.add(evidence.anchor.path);
    if (!isSecret && dirOf(evidence.anchor.path) !== "") usedDirs.add(dirOf(evidence.anchor.path));
    const title = titleOf(check, evidence.anchor.path);
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

  // Round-robin in severity order until three are picked or nothing new can be taken.
  let progress = true;
  while (picked.length < MAX_LOOK_HERE && progress) {
    progress = false;
    for (const check of flagged) {
      if (picked.length >= MAX_LOOK_HERE) break;
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

const titleOf = (check: CheckResult, path: string) => TITLES[check.id]?.(path) ?? `${check.title}: ${path}`;

/** How learning changes the pick: places to leave out, checks to take first, and why. */
export interface PickAdjustments {
  skip?: (check: CheckResult, title: string, path: string) => boolean;
  prefer?: (checkId: string) => boolean;
  why?: (checkId: string) => string | undefined;
}

/**
 * The places to look, with what you've taught Alden: a flag you marked "not needed" on this PR stays down on a
 * re-review, a check you usually don't need gives up its slots (never a high-severity one), and a check you usually
 * agree with goes first among equals. What learning left out is returned as hidden, so the briefing can say so.
 */
export function pickWithLearning(
  checks: CheckResult[],
  learning: Learning | undefined,
  target: string,
): { eyes: LookHere[]; hidden: BriefingLearning["hidden"] } {
  if (!learning) return { eyes: pickLookHere(checks), hidden: [] };
  const hiddenWhy = (check: CheckResult, title: string, path: string): string | undefined => {
    const at = learning.dismissed.get(
      dismissKey(target, { source: "check", checkId: check.id, title, anchor: { path } }),
    );
    if (at) return `You dismissed it on ${at.slice(0, 10)}`;
    const lesson = learning.paused ? undefined : learning.checks.get(check.id);
    if (lesson?.direction === "down" && check.severity !== "high") return checkReason(lesson);
    return undefined;
  };
  const eyes = pickLookHere(checks, {
    skip: (check, title, path) => hiddenWhy(check, title, path) !== undefined,
    prefer: (id) => !learning.paused && learning.checks.get(id)?.direction === "up",
    why: (id) => {
      const lesson = learning.paused ? undefined : learning.checks.get(id);
      return lesson?.direction === "up" ? checkReason(lesson) : undefined;
    },
  });
  const shown = new Set(eyes.map((e) => `${e.checkId}|${e.anchor?.path}`));
  const hidden = pickLookHere(checks).flatMap((item) => {
    const check = checks.find((c) => c.id === item.checkId);
    if (!check || !item.anchor || shown.has(`${item.checkId}|${item.anchor.path}`)) return [];
    const reason = hiddenWhy(check, item.title, item.anchor.path);
    return reason ? [{ title: item.title, reason, anchor: item.anchor }] : [];
  });
  return { eyes, hidden };
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
