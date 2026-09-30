import { z } from "zod";

/**
 * A repo's review speed, from its merged PRs: phase 1's OSS metrics (time to first review and review cycle time),
 * split into before and after Alden so a team sees its own change. Bump `STATS_SCHEMA_VERSION` on breaking changes.
 */
export const STATS_SCHEMA_VERSION = 1;

/** Hours, as a distribution: how many PRs, the median and the 90th percentile. */
export const DistributionSchema = z.object({
  count: z.number().int(),
  medianHours: z.number().nullable(),
  p90Hours: z.number().nullable(),
});

export const MetricSchema = z.object({
  all: DistributionSchema,
  before: DistributionSchema.nullable().describe("PRs ready for review before the split; null without a split"),
  after: DistributionSchema.nullable(),
});

export const RepoStatsSchema = z.object({
  schemaVersion: z.literal(STATS_SCHEMA_VERSION),
  repo: z.string(),
  fetchedAt: z.iso.datetime(),
  window: z.object({ from: z.iso.datetime(), to: z.iso.datetime() }),
  split: z
    .object({ at: z.iso.datetime(), source: z.enum(["first-use", "since"]) })
    .nullable()
    .describe("where before becomes after: when you first used Alden on this repo, or --since"),
  prs: z.number().int().describe("PRs opened in the window (open, merged or closed), bots and drafts included"),
  /**
   * Every wait is measured up to this many hours, and only for PRs ready at least this long ago, so before and after
   * are judged over the same stretch of time. A median equal to it means "this long or more".
   */
  horizonHours: z.number(),
  /** Ready for review (or opened, if never a draft) → first review by someone other than the author, or now if none yet. */
  timeToFirstReview: MetricSchema,
  /** Ready for review → first approval by someone other than the author. */
  cycleTime: MetricSchema,
  weeks: z.array(
    z.object({
      week: z.string().describe("the Monday the week starts, YYYY-MM-DD"),
      prs: z.number().int(),
      timeToFirstReviewMedianHours: z.number().nullable(),
      cycleTimeMedianHours: z.number().nullable(),
    }),
  ),
  excluded: z.object({
    bots: z.number().int().describe("PRs by bots, left out of both metrics"),
    drafts: z.number().int().describe("still drafts, so never ready for review"),
    tooRecent: z.number().int().describe("ready for review less than the horizon ago, so not judged yet"),
    noReview: z.number().int().describe("merged or closed without a review by someone else"),
    noApproval: z.number().int().describe("merged or closed without an approval by someone else"),
  }),
  /**
   * Open PRs (old enough to judge) with no review or approval yet. They count as the full horizon: leaving them out
   * would favour recent weeks, where only the quick PRs have finished.
   */
  stillWaiting: z.object({ review: z.number().int(), approval: z.number().int() }),
  truncated: z.boolean().describe("GitHub's search stops at 1,000 results, so older PRs in the window may be missing"),
});

export type Distribution = z.infer<typeof DistributionSchema>;
export type Metric = z.infer<typeof MetricSchema>;
export type RepoStats = z.infer<typeof RepoStatsSchema>;
