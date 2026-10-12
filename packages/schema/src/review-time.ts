import { z } from "zod";

/**
 * How long your reviews take with Alden, from the review sessions it records on this machine (`stats.reviewTime`):
 * from opening a PR's briefing to sending the review. Bump `REVIEW_TIME_SCHEMA_VERSION` on breaking changes.
 */
export const REVIEW_TIME_SCHEMA_VERSION = 1;

/** Fewer reviews than this in a group, and its medians say little: the UI and CLI say so. */
export const REVIEW_TIME_SMALL_SAMPLE = 10;

/** The windows "Time to review" shows, in days, by the date the briefing was first opened. */
export const REVIEW_TIME_WINDOWS = [14, 30, 90] as const;

export const ReviewTimeGroupSchema = z.object({
  count: z.number().int().describe("reviews sent, opened in the window and old enough to judge"),
  activeMedianMinutes: z.number().nullable().describe("median active minutes per review; null without reviews"),
  wallMedianMinutes: z
    .number()
    .nullable()
    .describe("median minutes from first opening the briefing to sending, capped at the horizon"),
  estimated: z
    .number()
    .int()
    .describe(
      "reviews whose active time is the terminal's estimate (briefing to send, capped), not measured in the UI",
    ),
  small: z.boolean().describe(`fewer than ${REVIEW_TIME_SMALL_SAMPLE} reviews: too few to read much into`),
});

export const ReviewTimeWindowSchema = z.object({
  days: z.number().int(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  all: ReviewTimeGroupSchema,
  withModel: ReviewTimeGroupSchema.describe("Alden's model briefed the PR, or drafted for it, during the session"),
  withoutModel: ReviewTimeGroupSchema,
  excluded: z.object({
    tooRecent: z.number().int().describe("opened less than the horizon ago, sent or not: judged once they're older"),
    notSent: z.number().int().describe("opened at least the horizon ago and never sent from Alden"),
  }),
});

export const ReviewTimeStatsSchema = z.object({
  schemaVersion: z.literal(REVIEW_TIME_SCHEMA_VERSION),
  generatedAt: z.iso.datetime(),
  enabled: z.boolean().describe("stats.reviewTime: whether Alden is recording review sessions"),
  /**
   * Reviews are grouped by when their briefing was first opened, and judged only once they're this old: a review
   * opened yesterday and still unsent would otherwise drop out while yesterday's quick ones count. Open-to-send times
   * are capped at it, so a median equal to it means "this long or more".
   */
  horizonHours: z.number(),
  windows: z.array(ReviewTimeWindowSchema),
});

export type ReviewTimeGroup = z.infer<typeof ReviewTimeGroupSchema>;
export type ReviewTimeWindow = z.infer<typeof ReviewTimeWindowSchema>;
export type ReviewTimeStats = z.infer<typeof ReviewTimeStatsSchema>;
