import { z } from "zod";

/**
 * How Alden writes the comments it drafts for you, in every drafting path (the briefing's drafts, "Draft my review",
 * "Draft with Alden"):
 *
 * - terse: one line, no reasoning.
 * - concise: one to three plain sentences, what's wrong and what to do (the default).
 * - detailed: why, the impact and a fix.
 * - teaching: for newer teammates, with the principle behind it.
 */
export const DRAFT_TONES = ["terse", "concise", "detailed", "teaching"] as const;

export const DraftToneSchema = z.enum(DRAFT_TONES);
export type DraftTone = z.infer<typeof DraftToneSchema>;

/** The tone for a repo (`GET /api/tone`): its own, set on this machine, or the global `drafts.tone`. */
export const ToneStateSchema = z.object({
  tone: DraftToneSchema,
  source: z.enum(["repo", "default"]).describe("repo: set for this repo on this machine; default: drafts.tone"),
});
export type ToneState = z.infer<typeof ToneStateSchema>;

/** A question about a PR (`POST /api/ask`), answered with its briefing, diff and your notes in one model call. */
export const AskRequestSchema = z.object({
  pr: z.string().min(1).describe("owner/repo#N, a PR URL or a queue number"),
  question: z.string().min(1).max(4_000),
  model: z.string().min(1).optional().describe("a model for this question only, like `alden review --model`"),
});
export type AskRequest = z.infer<typeof AskRequestSchema>;

/** One line of the streamed answer: text as it comes, then done (with the cost) or an error. */
export const AskEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({
    type: z.literal("done"),
    costUsd: z.number().nullable().describe("null when the model has no known price (a local model)"),
    model: z.string(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    status: z
      .number()
      .int()
      .describe(
        "409: no model, no briefing for this head, text aimed at AI reviewers, or over budget; 502: the provider failed",
      ),
  }),
]);
export type AskEvent = z.infer<typeof AskEventSchema>;
