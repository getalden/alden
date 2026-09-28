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
});

export type Anchor = z.infer<typeof AnchorSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type CheckStatus = z.infer<typeof CheckStatusSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type CheckResult = z.infer<typeof CheckResultSchema>;
export type LookHere = z.infer<typeof LookHereSchema>;
export type BriefingFile = z.infer<typeof BriefingFileSchema>;
export type BriefingTarget = z.infer<typeof BriefingTargetSchema>;
export type Briefing = z.infer<typeof BriefingSchema>;
