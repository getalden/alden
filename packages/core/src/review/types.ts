import type { AldenConfig, BriefingTarget, CheckResult } from "@alden/schema";
import type { DiffFile } from "../diff/parse.js";
import type { PullRequestFacts } from "../github/pull-requests.js";
import type { ChangedSymbol } from "../graph/changes.js";
import type { CallSite } from "../graph/query.js";
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
  /** The code graph's view of the change, when the repo could be indexed. */
  graph?: GraphContext;
}

/** Changed public symbols and who calls them, worked out before the checks run. */
export interface GraphContext {
  changes: ChangedSymbol[];
  /** Callers per changed symbol, keyed by `symbolKey`, excluding call sites the diff itself changed. */
  callers: Map<string, CallSite[]>;
  /** False when indexing ran out of time, so some callers may be missing. */
  complete: boolean;
}

/** "path#Class.method" or "path#name". */
export const symbolKey = (s: { path: string; name: string; container?: string }) =>
  `${s.path}#${s.container ? `${s.container}.` : ""}${s.name}`;

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
