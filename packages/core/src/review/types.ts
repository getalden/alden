import type { AldenConfig, BriefingTarget, CheckResult } from "@alden/schema";
import type { DiffFile } from "../diff/parse.js";
import type { PullRequestFacts } from "../github/pull-requests.js";
import type { ManifestSnapshot } from "./dependencies.js";

/** Everything a check may look at. Checks are pure: same context, same result. */
export interface ReviewContext {
  target: BriefingTarget;
  files: DiffFile[];
  /** The PR's facts from the queue fetch (CI, labels…). Absent for local changes. */
  pr?: PullRequestFacts;
  config: AldenConfig;
  /**
   * Changed manifests read in full on both sides, so dependency changes come from real parsing rather than diff lines.
   * Absent when they couldn't be read; the dependency check then says so.
   */
  manifests?: ManifestSnapshot[];
}

/** What a check returns; the runner adds its id, title and heuristic flag. */
export type CheckOutcome = Omit<CheckResult, "id" | "title" | "heuristic">;

export interface Check {
  id: string;
  title: string;
  /** True when the check infers from the diff alone and may be wrong. */
  heuristic: boolean;
  run(context: ReviewContext): CheckOutcome;
}

/** Evidence lists stay short; the rest is summarised as "and N more". */
export const MAX_EVIDENCE = 5;
