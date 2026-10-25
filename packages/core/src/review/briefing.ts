import { BRIEFING_SCHEMA_VERSION, type Briefing, type BriefingTarget, type CheckResult } from "@alden/schema";
import { fileKind, isLockfile } from "../queue/files.js";
import { CHECKS } from "./checks.js";
import { filesOutsideGraph } from "./graph-context.js";
import { pickWithLearning } from "./pick.js";
import { withRelated } from "./related.js";
import type { Check, ReviewContext } from "./types.js";

/**
 * What this version of Alden does not look at. Shown in every briefing so "checked" never implies more than it
 * means. Shrinks as checks land.
 */
export const NOT_CHECKED = [
  "Whether the change does what its title says (only the model can judge that; see `alden review --help`)",
  "Callers and code outside the diff (the code graph didn't run)",
];

/** What the code graph couldn't cover in this review, in place of the generic "callers" line when it ran. */
function notCheckedFor(context: ReviewContext): string[] {
  const [titleLine, callersLine] = NOT_CHECKED as [string, string];
  if (!context.graph) {
    // The reason (no clone, --no-graph, a failure) is on the "Callers outside the diff" check itself.
    return [
      titleLine,
      context.graphUnavailable ? "Callers and code outside the diff (why is under Checked, above)" : callersLine,
    ];
  }
  const outside = filesOutsideGraph(context.files);
  const more = outside.length > 3 ? ` and ${outside.length - 3} more` : "";
  return [
    titleLine,
    ...(outside.length > 0
      ? [
          `Callers of changes in ${outside.slice(0, 3).join(", ")}${more} (the code graph reads TypeScript, JavaScript, Python, Go, PHP, Ruby, Swift, Java and Kotlin)`,
        ]
      : []),
    ...(context.graph.complete ? [] : ["Some callers: indexing the repo ran out of time"]),
    "Uses of changed types and interfaces (the compiler catches those)",
  ];
}

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

/** Which PR (or "local") a briefing is for, as learning keys feedback. */
export const learningTarget = (target: BriefingTarget) =>
  target.kind === "pr" ? `${target.repo.toLowerCase()}#${target.number}` : "local";

export function buildBriefing(context: ReviewContext, now: Date = new Date()): Briefing {
  const reviewable = context.files.filter((f) => !isLockfile(f.path));
  const checks = runChecks(context);
  const { eyes, hidden, quietened } = pickWithLearning(
    checks,
    context.learning,
    learningTarget(context.target),
    context.config.review.eyes,
  );
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
    needsYourEyes: withRelated(eyes, context.graph),
    notChecked: [
      ...notCheckedFor(context),
      ...context.files.filter((f) => f.patchMissing).map((f) => `${f.path}: too large for GitHub to send its diff`),
    ],
    ...(hidden.length > 0 || quietened.length > 0
      ? { learning: { hidden, ...(quietened.length > 0 ? { quietened } : {}), memory: 0 } }
      : {}),
  };
}
