import type { AldenConfig, BriefingTarget, CheckResult } from "@alden/schema";
import type { DiffFile } from "../diff/parse.js";
import type { PullRequestFacts } from "../github/pull-requests.js";
import type { ChangedSymbol } from "../graph/changes.js";
import type { CallSite } from "../graph/query.js";
import type { Learning } from "../learn/learn.js";
import type { ManifestSnapshot } from "./dependencies.js";

/** Everything a check may look at. Checks are pure: same context, same result. */
export interface ReviewContext {
  target: BriefingTarget;
  files: DiffFile[];
  /** The PR's facts from the queue fetch (CI, labels…). Absent for local changes. */
  pr?: PullRequestFacts;
  /** The PR's description, written by its author. Absent for local changes. */
  description?: string;
  config: AldenConfig;
  /**
   * Changed manifests read in full on both sides, so dependency changes come from real parsing rather than diff lines.
   * Absent when they couldn't be read; the dependency check then says so.
   */
  manifests?: ManifestSnapshot[];
  /** The code graph's view of the change, when the repo could be indexed. */
  graph?: GraphContext;
  /** Why there's no graph (e.g. not run from a clone of the PR's repo), shown by the callers check. */
  graphUnavailable?: string;
  /** What Alden has learned about this reviewer in this repo. Not seen by checks, only by the picker. */
  learning?: Learning;
}

/** Changed public symbols and who calls them, worked out before the checks run. */
export interface GraphContext {
  changes: ChangedSymbol[];
  /** Callers per changed symbol, keyed by `symbolKey`, excluding call sites the diff itself changed. */
  callers: Map<string, CallSite[]>;
  /** False when indexing ran out of time, so some callers may be missing. */
  complete: boolean;
  /** Changed files the graph parsed (before or after), whose symbols and signatures it knows. */
  covered?: Set<string>;
  /** Code files the change moved or deleted, with the places still importing them by their old path. */
  modules?: ModuleChange[];
}

/** A module gone from its old path: moved (`movedTo`) or deleted. Its importers break like a removed symbol's callers. */
export interface ModuleChange {
  path: string;
  movedTo?: string;
  importers: CallSite[];
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
