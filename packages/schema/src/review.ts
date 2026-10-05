import { z } from "zod";

/**
 * Comments you write in Alden, kept as a pending review until you send them to GitHub as one review. Drafts stay in
 * the local database; they're never in telemetry or the feedback export, and nothing posts until you send.
 * Bump `REVIEW_SCHEMA_VERSION` on any breaking change.
 */
export const REVIEW_SCHEMA_VERSION = 1;

export const ReviewDraftSchema = z.object({
  id: z.string(),
  pr: z.string().describe('the PR, "owner/repo#123"'),
  headSha: z.string().describe("the PR's head commit the draft's line refers to"),
  path: z.string().optional().describe("the file; absent for a general note, which goes into the review's body"),
  line: z.number().int().positive().optional().describe("the line, on `side`; absent for a general note"),
  side: z
    .enum(["RIGHT", "LEFT"])
    .optional()
    .describe("RIGHT: the line in the new file (added or unchanged); LEFT: in the old file (removed)"),
  body: z.string().min(1),
  source: z.enum(["you", "claude"]).describe("who wrote it: you, or Claude Code drafting for you"),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  state: z
    .enum(["draft", "outdated"])
    .describe("outdated: the PR moved on and the line couldn't be found again, so it can't be sent until it's placed"),
});

/** What a review says overall, as GitHub names it. */
export const ReviewEventSchema = z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]);

export const SendReviewResultSchema = z.object({
  url: z.string().describe("the review on GitHub"),
  posted: z.number().int().min(0).describe("comments posted: inline ones and general notes"),
  review: ReviewEventSchema,
});

/** A place Alden flagged in the latest briefing of a PR that no draft is near: worth a look before approving. */
export const UnaddressedPlaceSchema = z.object({
  checkId: z.string().describe('the check that raised it, or "model" for the model\'s own'),
  title: z.string(),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
});

export const ReviewDraftsSchema = z.object({
  drafts: z.array(ReviewDraftSchema),
  unaddressed: z.array(UnaddressedPlaceSchema),
});

export type ReviewDraft = z.infer<typeof ReviewDraftSchema>;
export type ReviewEvent = z.infer<typeof ReviewEventSchema>;
export type SendReviewResult = z.infer<typeof SendReviewResultSchema>;
export type UnaddressedPlace = z.infer<typeof UnaddressedPlaceSchema>;
export type ReviewDrafts = z.infer<typeof ReviewDraftsSchema>;
