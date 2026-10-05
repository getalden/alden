import { z } from "zod";
import { AnchorSchema, SeveritySchema } from "./briefing.js";

/**
 * What a reviewer said about a briefing: useful or not useful on one of its flags, or "you missed something". This
 * is how phase 1's gate is measured (reviewers find most "needs your eyes" flags useful), so it's kept, locally, as
 * an append-only log. Bump `FEEDBACK_SCHEMA_VERSION` on any breaking change.
 */
export const FEEDBACK_SCHEMA_VERSION = 1;

/** Which briefing: the PR (or local changes) and when the briefing was made, so re-reviews count separately. */
export const FeedbackTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pr"), repo: z.string(), number: z.number().int() }),
  z.object({ kind: z.literal("local"), repo: z.string().nullable().describe("owner/name when known") }),
]);

/** The flag a verdict is about: a "needs your eyes" item or one of the model's other findings. */
export const FeedbackItemSchema = z.object({
  source: z.enum(["check", "llm"]),
  checkId: z.string().optional().describe("the check that raised it; absent for model findings"),
  title: z.string(),
  severity: SeveritySchema.optional(),
  anchor: AnchorSchema.optional(),
  /**
   * "eyes" when it was one of the few places to look, "finding" for the model's other findings, "check"
   * for a check's own row ("worth flagging?").
   */
  placement: z.enum(["eyes", "finding", "check"]),
});

const common = {
  schemaVersion: z.literal(FEEDBACK_SCHEMA_VERSION),
  id: z.string(),
  at: z.iso.datetime(),
  target: FeedbackTargetSchema,
  briefingAt: z.iso.datetime().describe("the briefing's generatedAt"),
  model: z.string().optional().describe("the model that contributed to the briefing, if any"),
};

export const FeedbackEventSchema = z.discriminatedUnion("kind", [
  z.object({
    ...common,
    kind: z.literal("verdict"),
    item: FeedbackItemSchema,
    /**
     * "agree" (useful) and "not_needed" (not useful) teach Alden about the kind of flag; "dismiss" only hides this one
     * on this PR. "clear" takes a verdict back. The latest verdict on an item wins.
     */
    verdict: z.enum(["agree", "not_needed", "dismiss", "clear"]),
    /**
     * "comment": not said but done. You commented near this place in a review you sent, which counts as useful (once
     * per place per PR, and never over a verdict you gave yourself). Absent: you said it.
     */
    via: z.literal("comment").optional(),
  }),
  z.object({
    ...common,
    kind: z.literal("missed"),
    note: z.string().min(1).max(2000).describe("what Alden should have flagged"),
    anchor: AnchorSchema.optional(),
  }),
]);

/** A new event as a front end sends it; the log adds the id, time and version. */
export const FeedbackInputSchema = z.discriminatedUnion("kind", [
  FeedbackEventSchema.options[0].omit({ schemaVersion: true, id: true, at: true, via: true }),
  FeedbackEventSchema.options[1].omit({ schemaVersion: true, id: true, at: true }),
]);

const counts = z.object({ agree: z.number().int(), notNeeded: z.number().int() });

export const FeedbackSummarySchema = z.object({
  /** Verdicts in force (the latest per flag, cleared ones dropped). */
  verdicts: z.number().int(),
  agree: z.number().int(),
  notNeeded: z.number().int(),
  /** agree / verdicts on "needs your eyes" items: the gate's number. Null until there's a verdict. */
  eyesAgreeRate: z.number().nullable(),
  eyes: counts,
  modelFindings: counts,
  bySource: z.object({ check: counts, llm: counts }),
  byCheck: z.record(z.string(), counts),
  dismissed: z.number().int().describe("places dismissed on one PR; not counted as useful or not useful"),
  missed: z.number().int(),
  briefings: z.number().int().describe("briefings with any feedback"),
  since: z.iso.datetime().nullable(),
});

export type FeedbackTarget = z.infer<typeof FeedbackTargetSchema>;
export type FeedbackItem = z.infer<typeof FeedbackItemSchema>;
export type FeedbackEvent = z.infer<typeof FeedbackEventSchema>;
export type FeedbackInput = z.infer<typeof FeedbackInputSchema>;
export type FeedbackSummary = z.infer<typeof FeedbackSummarySchema>;
