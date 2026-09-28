import { BRIEFING_SCHEMA_VERSION, type Briefing, type CheckResult } from "@alden/schema";
import { fileKind, isLockfile } from "../queue/files.js";
import { CHECKS } from "./checks.js";
import { pickLookHere } from "./pick.js";
import type { Check, ReviewContext } from "./types.js";

/**
 * What this version of Alden does not look at. Shown in every briefing so "checked" never implies more than it
 * means. Shrinks as checks land.
 */
export const NOT_CHECKED = [
  "Whether the change does what its title says (the LLM briefing is coming)",
  "Callers and code outside the diff (the code graph is coming)",
];

/** Runs every check. A check that throws is reported as skipped rather than failing the whole review. */
export function runChecks(context: ReviewContext, checks: Check[] = CHECKS): CheckResult[] {
  return checks.map((check) => {
    const base = { id: check.id, title: check.title, heuristic: check.heuristic };
    try {
      return { ...base, ...check.run(context) };
    } catch (error) {
      return {
        ...base,
        status: "skipped",
        severity: "info",
        summary: `The check failed to run: ${(error as Error).message}`,
        evidence: [],
      };
    }
  });
}

export function buildBriefing(context: ReviewContext, now: Date = new Date()): Briefing {
  const reviewable = context.files.filter((f) => !isLockfile(f.path));
  const checks = runChecks(context);
  return {
    schemaVersion: BRIEFING_SCHEMA_VERSION,
    target: context.target,
    generatedAt: now.toISOString(),
    summary: {
      files: context.files.length,
      additions: context.files.reduce((sum, f) => sum + f.additions, 0),
      deletions: context.files.reduce((sum, f) => sum + f.deletions, 0),
      reviewableAdditions: reviewable.reduce((sum, f) => sum + f.additions, 0),
      reviewableDeletions: reviewable.reduce((sum, f) => sum + f.deletions, 0),
    },
    files: context.files.map((f) => ({
      path: f.path,
      ...(f.previousPath ? { previousPath: f.previousPath } : {}),
      status: f.status,
      kind: fileKind(f.path),
      additions: f.additions,
      deletions: f.deletions,
      binary: f.binary,
      patchMissing: f.patchMissing,
    })),
    checks,
    needsYourEyes: pickLookHere(checks),
    notChecked: [
      ...NOT_CHECKED,
      ...context.files.filter((f) => f.patchMissing).map((f) => `${f.path}: too large for GitHub to send its diff`),
    ],
  };
}
