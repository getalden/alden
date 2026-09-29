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
export const SeveritySchema = z.enum(["info", "low", "medium", "high"]);

export const CheckResultSchema = z.object({
  id: z.string().describe("stable identifier, e.g. tests.missing"),
  title: z.string().describe("what the check looks for, e.g. Code changed without tests"),
  status: CheckStatusSchema,
  severity: SeveritySchema.describe("how much a flag matters; info for passed and skipped checks"),
  summary: z.string().describe("the result in one sentence"),
  evidence: z.array(EvidenceSchema),
  heuristic: z.boolean().describe("true when the check infers from the diff alone and may be wrong"),
});

export const LookHereSchema = z.object({
  title: z.string(),
  reason: z.string().describe("why a human should look, in one sentence"),
  anchor: AnchorSchema.optional(),
  checkId: z.string().optional().describe("the check that raised it, if any"),
  source: z.enum(["check", "llm"]).optional().describe("a deterministic check or the model; absent means check"),
});

/** What the model found, after Alden has thrown away anything pointing at a line that isn't in the diff. */
export const LlmFindingSchema = z.object({
  title: z.string(),
  detail: z.string().describe("what's wrong or worth checking, and why, in one or two sentences"),
  severity: SeveritySchema,
  /** One finding can cover several places, e.g. the same change repeated across ten files. */
  anchors: z.array(AnchorSchema),
});

export const LlmSectionSchema = z.object({
  status: z
    .enum(["ok", "refused", "over_budget", "failed", "truncated", "skipped"])
    .describe("ok, or why there is no model section"),
  note: z.string().optional().describe("one line explaining a status other than ok"),
  provider: z.string().optional(),
  model: z.string().optional(),
  summary: z.string().optional().describe("what the change does, in plain words"),
  matchesTitle: z
    .object({ verdict: z.enum(["yes", "partly", "no", "unclear"]), reason: z.string() })
    .optional()
    .describe("whether the change does what its title and description say"),
  findings: z.array(LlmFindingSchema),
  droppedFindings: z.number().int().describe("findings discarded for pointing at lines not in the diff"),
  omittedFiles: z.array(z.string()).describe("files left out of the model's view to fit the budget"),
  usd: z.number().optional().describe("what the call cost at list price, when known"),
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
  needsYourEyes: z.array(LookHereSchema).max(3),
  notChecked: z.array(z.string()).describe("what Alden did not check, stated plainly"),
  llm: LlmSectionSchema.optional().describe("the model's view; absent when no model was asked"),
});

export type Anchor = z.infer<typeof AnchorSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type CheckStatus = z.infer<typeof CheckStatusSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type CheckResult = z.infer<typeof CheckResultSchema>;
export type LookHere = z.infer<typeof LookHereSchema>;
export type BriefingFile = z.infer<typeof BriefingFileSchema>;
export type BriefingTarget = z.infer<typeof BriefingTargetSchema>;
export type LlmFinding = z.infer<typeof LlmFindingSchema>;
export type LlmSection = z.infer<typeof LlmSectionSchema>;
export type Briefing = z.infer<typeof BriefingSchema>;
