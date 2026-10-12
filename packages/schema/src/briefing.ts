import { z } from "zod";

/**
 * A briefing: what one PR (or your local changes) touches, what Alden checked with evidence, and the few places a
 * reviewer should look. Rendered by the CLI, the local UI, the desktop app and the Claude Code plugin alike.
 * Bump `BRIEFING_SCHEMA_VERSION` on any breaking change.
 */
export const BRIEFING_SCHEMA_VERSION = 1;

/** A place in the change: a file, optionally a line in the new version of it. */
export const AnchorSchema = z.object({
  path: z.string(),
  line: z.number().int().positive().optional().describe("line in the new file; absent for whole-file findings"),
});

export const EvidenceSchema = z.object({
  text: z.string().describe("what Alden looked at or found, in one line"),
  anchor: AnchorSchema.optional(),
});

export const CheckStatusSchema = z.enum(["passed", "flagged", "skipped"]);
/** `critical` is for flags that can do damage on their own: a likely secret, a migration that drops data. */
export const SeveritySchema = z.enum(["info", "low", "medium", "high", "critical"]);

export const CheckResultSchema = z.object({
  id: z.string().describe("stable identifier, e.g. tests.missing"),
  title: z.string().describe("what the check looks for, e.g. Code changed without tests"),
  status: CheckStatusSchema,
  severity: SeveritySchema.describe("how much a flag matters; info for passed and skipped checks"),
  summary: z.string().describe("the result in one sentence"),
  evidence: z.array(EvidenceSchema),
  heuristic: z.boolean().describe("true when the check infers from the diff alone and may be wrong"),
});

/**
 * A file worth opening beside a place to look: code that calls the changed symbol there, a test that uses it or imports
 * its file, or a file importing the changed module. From the code graph, so only when it ran.
 */
export const RelatedFileSchema = z.object({
  path: z.string(),
  line: z.number().int().positive().optional().describe("the call or import in that file"),
  why: z.enum(["caller", "test", "importer"]),
});

/** The reviewer's note a model finding came from: the note's own id and its text when the review ran. */
export const FromNoteSchema = z.object({
  id: z.string().describe("the note's id in memory, e.g. note:1a2b3c4d"),
  text: z.string().describe("the note's text, as the model was given it"),
});

export const LookHereSchema = z.object({
  title: z.string(),
  reason: z.string().describe("why a human should look, in one sentence"),
  anchor: AnchorSchema.optional(),
  checkId: z.string().optional().describe("the check that raised it, if any"),
  source: z.enum(["check", "llm"]).optional().describe("a deterministic check or the model; absent means check"),
  learned: z
    .string()
    .optional()
    .describe("why your feedback put it here, e.g. 'you usually mark migration flags useful'"),
  fromNote: FromNoteSchema.optional().describe("for a model finding: the reviewer's note that is the reason for it"),
  related: z
    .array(RelatedFileSchema)
    .optional()
    .describe(
      "files to look at too: callers of the changed code here, tests that use it, files importing it; absent without the code graph or when there are none",
    ),
});

/** What the reviewer's feedback changed in this briefing, so nothing is hidden silently. */
export const BriefingLearningSchema = z.object({
  hidden: z
    .array(z.object({ title: z.string(), reason: z.string(), anchor: AnchorSchema.optional() }))
    .describe("places that would have been picked, left out because of your feedback"),
  quietened: z
    .array(z.object({ checkId: z.string(), reason: z.string() }))
    .optional()
    .describe(
      "flagged checks your feedback quietened: still run and listed, but left out of the places to look, e.g. 'quietened by your feedback: you usually mark untested-change flags not useful (3 of 3)'",
    ),
  memory: z.number().int().describe("notes about you that were given to the model"),
});

/**
 * The review comment the model drafted for a finding, when `drafts.auto` is on: what a careful reviewer would leave on
 * the finding's first anchored line. Alden turns it into a draft labelled "Drafted by Alden", which you keep, edit or
 * drop; it's never sent on its own.
 */
export const LlmFindingDraftSchema = z.object({
  body: z.string().describe("the comment, in plain direct words"),
  suggestion: z
    .string()
    .optional()
    .describe("replacement code for the anchored line, only when the fix is a small, certain replacement"),
});

/** What the model found, after Alden has thrown away anything pointing at a line that isn't in the diff. */
export const LlmFindingSchema = z.object({
  title: z.string(),
  checkId: z
    .string()
    .optional()
    .describe(
      "the check whose topic the model tagged it with (e.g. tests.missing), so feedback on it teaches that lesson",
    ),
  detail: z.string().describe("what's wrong or worth checking, and why, in one or two sentences"),
  severity: SeveritySchema,
  /** One finding can cover several places, e.g. the same change repeated across ten files. */
  anchors: z.array(AnchorSchema),
  fromNote: FromNoteSchema.optional().describe(
    "the reviewer's note that is the reason for this finding, when the model said so and the note was in its prompt",
  ),
  draft: LlmFindingDraftSchema.optional().describe(
    "a comment the model drafted for it, checked against the diff: only on medium and high findings on a changed line, when `drafts.auto` is on",
  ),
});

export const LlmSectionSchema = z.object({
  status: z
    .enum(["ok", "refused", "over_budget", "failed", "truncated", "skipped"])
    .describe("ok, or why there is no model section"),
  note: z.string().optional().describe("one line explaining a status other than ok"),
  provider: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional().describe("the effort level sent, when one was"),
  summary: z.string().optional().describe("what the change does, in plain words"),
  matchesTitle: z
    .object({ verdict: z.enum(["yes", "partly", "no", "unclear"]), reason: z.string() })
    .optional()
    .describe("whether the change does what its title and description say"),
  findings: z.array(LlmFindingSchema),
  droppedFindings: z.number().int().describe("findings discarded for pointing at lines not in the diff"),
  omittedFiles: z.array(z.string()).describe("files left out of the model's view to fit the budget"),
  redactedSecrets: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("likely secrets replaced with placeholders before the prompt was sent"),
  usd: z.number().optional().describe("what the call cost at list price, when known"),
  draftsNote: z
    .string()
    .optional()
    .describe(
      "why a PR's model briefing has no drafted comments, in one line: drafting is off (`drafts.auto`), text in the PR aimed at AI reviewers, or no finding Alden drafts for",
    ),
});

export const BriefingFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  status: z.enum(["added", "modified", "removed", "renamed"]),
  kind: z.enum(["docs", "test", "dependency", "code", "other"]),
  additions: z.number().int(),
  deletions: z.number().int(),
  binary: z.boolean(),
  patchMissing: z.boolean().describe("the file changed but its diff was too large to fetch"),
});

export const BriefingTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pr"),
    repo: z.string(),
    number: z.number().int(),
    url: z.url(),
    title: z.string(),
    author: z.string().nullable(),
    baseRef: z.string(),
    headRef: z.string(),
    headSha: z.string().optional().describe("the PR head commit briefed; absent in briefings from before Alden 0.5"),
    baseSha: z
      .string()
      .optional()
      .describe(
        "the base commit the code graph saw (the merge's first parent); absent when it came from the PR's branch",
      ),
    graphFrom: z
      .enum(["merge", "head"])
      .optional()
      .describe(
        "where callers came from: GitHub's merge of the PR onto its latest base, or the PR's own branch (it conflicts, or GitHub hasn't merged it yet); absent when the graph didn't run",
      ),
  }),
  z.object({
    kind: z.literal("local"),
    repoRoot: z.string(),
    branch: z.string().nullable(),
  }),
]);

export const BriefingSchema = z.object({
  schemaVersion: z.literal(BRIEFING_SCHEMA_VERSION),
  target: BriefingTargetSchema,
  generatedAt: z.iso.datetime(),
  summary: z.object({
    files: z.number().int(),
    additions: z.number().int(),
    deletions: z.number().int(),
    reviewableAdditions: z.number().int().describe("additions outside lockfiles"),
    reviewableDeletions: z.number().int().describe("deletions outside lockfiles"),
  }),
  files: z.array(BriefingFileSchema),
  checks: z.array(CheckResultSchema),
  needsYourEyes: z.array(LookHereSchema).max(10).describe("the places to look first, `review.eyes` of them at most"),
  notChecked: z.array(z.string()).describe("what Alden did not check, stated plainly"),
  llm: LlmSectionSchema.optional().describe("the model's view; absent when no model was asked"),
  learning: BriefingLearningSchema.optional().describe("what your feedback and memory changed; absent when nothing"),
});

/**
 * Whether a PR briefing still matches the PR: `fresh`; the PR has new commits since (`pr_changed`); its base branch has
 * moved since the code graph saw it (`base_moved`, only for graphs from the merge); or `unknown` (an older briefing
 * without commits recorded, or GitHub couldn't be asked). `commits` is absent when GitHub can't count them, e.g. after
 * a force-push.
 */
export const BriefingFreshnessSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("fresh") }),
  z.object({ state: z.literal("pr_changed"), commits: z.number().int().positive().optional() }),
  z.object({
    state: z.literal("base_moved"),
    baseRef: z.string(),
    commits: z.number().int().positive().optional(),
  }),
  z.object({ state: z.literal("unknown"), reason: z.string() }),
]);

export type Anchor = z.infer<typeof AnchorSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type CheckStatus = z.infer<typeof CheckStatusSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type CheckResult = z.infer<typeof CheckResultSchema>;
export type LookHere = z.infer<typeof LookHereSchema>;
export type RelatedFile = z.infer<typeof RelatedFileSchema>;
export type BriefingLearning = z.infer<typeof BriefingLearningSchema>;
export type BriefingFile = z.infer<typeof BriefingFileSchema>;
export type BriefingTarget = z.infer<typeof BriefingTargetSchema>;
export type LlmFinding = z.infer<typeof LlmFindingSchema>;
export type LlmFindingDraft = z.infer<typeof LlmFindingDraftSchema>;
export type FromNote = z.infer<typeof FromNoteSchema>;
export type LlmSection = z.infer<typeof LlmSectionSchema>;
export type Briefing = z.infer<typeof BriefingSchema>;
export type BriefingFreshness = z.infer<typeof BriefingFreshnessSchema>;
