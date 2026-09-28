import type { CheckResult, Evidence, LookHere, Severity } from "@alden/schema";
import { isLockfile } from "../queue/files.js";

export const MAX_LOOK_HERE = 3;

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1, info: 0 };

/** Among equal severities, what a reviewer should see first. */
const CHECK_PRIORITY = [
  "secrets.likely",
  "migrations.changed",
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
  "dependencies.changed": (p) => `Dependency changes in ${p}`,
  "tests.missing": (p) => `Untested change in ${p}`,
  "config.changed": (p) => `Config change in ${p}`,
  "paths.sensitive": (p) => `Sensitive file ${p}`,
};

type Anchored = Evidence & { anchor: NonNullable<Evidence["anchor"]> };

/**
 * The few places a human should look, from the flagged checks: most severe first, at most one per file, at most
 * three. Each flagged check gets a slot before any check gets a second, so one noisy check can't crowd out the
 * rest, and a file flagged by two checks takes only one slot.
 */
export function pickLookHere(checks: CheckResult[]): LookHere[] {
  const flagged = checks
    .filter((c) => c.status === "flagged" && !NOT_A_PLACE.has(c.id))
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || rank(a.id) - rank(b.id));

  const picked: LookHere[] = [];
  const usedPaths = new Set<string>();
  const take = (check: CheckResult): boolean => {
    // Nobody reads a lockfile line by line; what changed in it is the dependency check's job. Secrets still count.
    const evidence = check.evidence.find(
      (e): e is Anchored =>
        e.anchor !== undefined &&
        !usedPaths.has(e.anchor.path) &&
        (check.id === "secrets.likely" || !isLockfile(e.anchor.path)),
    );
    if (!evidence) return false;
    usedPaths.add(evidence.anchor.path);
    const title = TITLES[check.id]?.(evidence.anchor.path) ?? `${check.title}: ${evidence.anchor.path}`;
    picked.push({ title, reason: `${evidence.text}. ${check.summary}`, anchor: evidence.anchor, checkId: check.id });
    return true;
  };

  // Round-robin in severity order until three are picked or nothing new can be taken.
  let progress = true;
  while (picked.length < MAX_LOOK_HERE && progress) {
    progress = false;
    for (const check of flagged) {
      if (picked.length >= MAX_LOOK_HERE) break;
      if (take(check)) progress = true;
    }
  }
  return picked;
}

function rank(id: string): number {
  const i = CHECK_PRIORITY.indexOf(id);
  return i === -1 ? CHECK_PRIORITY.length : i;
}
