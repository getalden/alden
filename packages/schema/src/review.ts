import { z } from "zod";

/**
 * Comments you write in Alden, kept as a pending review until you send them to GitHub as one review. Drafts stay in
 * the local database; they're never in telemetry or the feedback export, and nothing posts until you send.
 * Bump `REVIEW_SCHEMA_VERSION` on any breaking change.
 */
export const REVIEW_SCHEMA_VERSION = 1;

/**
 * Where a general note links to: code GitHub won't take an inline comment on (a line outside the PR's diff, a file the
 * PR doesn't change, or a whole file). The link is to that line at the draft's `headSha`: the code you saw when you
 * wrote it.
 */
export const DraftLinkSchema = z.object({
  path: z.string().min(1).describe("the file, as in the repo at the draft's head commit"),
  line: z.number().int().positive().optional().describe("the line (a range's last line); absent for a whole file"),
  startLine: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("a range's first line, less than `line`; absent for one line"),
});

export const ReviewDraftSchema = z
  .object({
    id: z.string(),
    pr: z.string().describe('the PR, "owner/repo#123"'),
    headSha: z.string().describe("the PR's head commit the draft's line refers to"),
    path: z
      .string()
      .optional()
      .describe("the file of an inline comment; absent for a general note, which goes into the review's body"),
    line: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("the line, on `side`; the last line of a multi-line comment; absent for a general note"),
    startLine: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("a multi-line comment's first line, on the same side and in the same hunk; always less than `line`"),
    side: z
      .enum(["RIGHT", "LEFT"])
      .optional()
      .describe("RIGHT: the line in the new file (added or unchanged); LEFT: in the old file (removed)"),
    body: z.string().describe("the comment, in Markdown; may be empty when the draft has a suggestion"),
    suggestion: z
      .string()
      .optional()
      .describe(
        'replacement code for the commented line(s), posted as a ```suggestion block after the body; empty deletes them. Only on the new side (RIGHT). On a linked note it can\'t be applied, so it posts as a code block headed "Suggested change"',
      ),
    originalLines: z
      .array(z.string())
      .optional()
      .describe("the text of the commented line(s) when the draft was placed: what a suggestion replaces"),
    linkTo: DraftLinkSchema.optional().describe(
      "on a general note: the line (or lines, or file) it's about, outside the PR's diff. It posts in the review body with a link to that code at `headSha`, the PR's head when it was written. Absent on an inline comment and a plain note",
    ),
    source: z.enum(["you", "claude"]).describe("who wrote it: you, or Claude Code drafting for you"),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    state: z
      .enum(["draft", "outdated"])
      .describe(
        "outdated: the PR moved on and the line couldn't be found again, so it can't be sent until it's placed",
      ),
  })
  .refine((d) => d.body.trim() !== "" || d.suggestion !== undefined, {
    message: "a comment needs some text, unless it's a suggestion",
    path: ["body"],
  })
  .refine((d) => d.linkTo === undefined || d.path === undefined, {
    message: "a linked note goes in the review body: it has linkTo, not a path of its own",
    path: ["linkTo"],
  });

/** What a review says overall, as GitHub names it. */
export const ReviewEventSchema = z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]);

export const SendReviewResultSchema = z.object({
  url: z.string().describe("the review on GitHub"),
  posted: z.number().int().min(0).describe("comments posted: inline ones and general notes"),
  review: ReviewEventSchema,
  learning: z
    .array(z.string())
    .optional()
    .describe(
      "what the review taught Alden, one line per lesson it moved, e.g. '2 of 3 (2 from your review of acme/shop#412): …'",
    ),
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
export type DraftLink = z.infer<typeof DraftLinkSchema>;
export type ReviewEvent = z.infer<typeof ReviewEventSchema>;
export type SendReviewResult = z.infer<typeof SendReviewResultSchema>;
export type UnaddressedPlace = z.infer<typeof UnaddressedPlaceSchema>;
export type ReviewDrafts = z.infer<typeof ReviewDraftsSchema>;
