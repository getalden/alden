import { z } from "zod";
import { FollowUpSummarySchema } from "./follow-ups.js";
import { ScoreLineSchema } from "./rank.js";

/**
 * The review queue as Alden hands it to every front end: the CLI's `--json`, the local UI, the desktop app and the
 * Claude Code plugin. Bump `QUEUE_SCHEMA_VERSION` on any breaking change.
 */
export const QUEUE_SCHEMA_VERSION = 1;

/**
 * CI on a PR's latest commit. `cancelled`: nothing failed, but a run was cancelled and didn't run again, so CI didn't
 * finish; it isn't the author's to fix, so it's never "failing".
 */
export const CiStateSchema = z.enum(["success", "failure", "pending", "cancelled", "none"]);

export const MajorBumpSchema = z.object({
  name: z.string().describe("the package, as its manifest names it"),
  from: z.string().describe('the major version before, e.g. "3", or "0.2" for a 0.x version'),
  to: z.string().describe("the major version after"),
});

export const PullRequestFactsSchema = z.object({
  repo: z.string().describe("owner/name"),
  number: z.number().int(),
  title: z.string(),
  url: z.url(),
  author: z.string().nullable().describe("null when the account was deleted"),
  authorIsBot: z.boolean().describe("the author is a bot account, e.g. Dependabot"),
  isDraft: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  baseRef: z.string(),
  headRef: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changedFiles: z.number().int(),
  files: z.array(z.object({ path: z.string(), additions: z.number().int(), deletions: z.number().int() })),
  filesTruncated: z.boolean().describe("true when the PR has more files than Alden fetched"),
  labels: z.array(z.string()),
  assignees: z
    .array(z.string())
    .optional()
    .describe("logins the PR is assigned to; absent in queues fetched before Alden read them"),
  ci: CiStateSchema,
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
  reviews: z.array(
    z.object({
      author: z.string().nullable(),
      state: z.string(),
      submittedAt: z.iso.datetime().nullable(),
      commit: z
        .string()
        .optional()
        .describe(
          "the head commit the review was submitted on; absent in queues fetched before Alden read it, and when GitHub no longer has it",
        ),
    }),
  ),
  request: z.object({
    direct: z.boolean().describe("the viewer was asked by name"),
    teams: z.array(z.string()).describe("the viewer's teams that were asked, as org/slug"),
    requestedAt: z.iso.datetime().nullable().describe("when the viewer or one of their teams was most recently asked"),
  }),
  codeownedFiles: z.array(z.string()).describe("changed files the viewer owns through CODEOWNERS"),
  stackedPrs: z.number().int().describe("open PRs built on top of this one"),
  majorBumps: z
    .array(MajorBumpSchema)
    .optional()
    .describe("dependencies the PR's manifest changes move up a major version (or a 0.x minor one)"),
});

export const LaneSchema = z.enum(["needs-you", "fast-track"]);
export const FastTrackKindSchema = z.enum(["docs only", "tests only", "dependency patch bump"]);

export const RankedPullRequestSchema = z.object({
  pr: PullRequestFactsSchema,
  lane: LaneSchema,
  fastTrack: FastTrackKindSchema.optional().describe("why it qualified for fast-track; only set in that lane"),
  score: z.object({
    risk: z.number(),
    wait: z.number(),
    blocking: z.number(),
    learned: z.number().optional().describe("points added because you usually open PRs like this first"),
    rules: z.number().optional().describe("points your boost and lower rules added or took away"),
    total: z.number(),
  }),
  pinned: z
    .enum(["first", "last"])
    .optional()
    .describe("a rule of yours puts it above (first) or below (last) every PR no rule pins in its lane"),
  breakdown: z
    .array(ScoreLineSchema)
    .optional()
    .describe("the score by weight and rule, adding up to score.total, as `alden queue --explain` shows it"),
  reasons: z.array(z.string()).describe("short human reasons, heaviest first"),
  waitingHours: z.number().describe("hours since the viewer was asked, or since the PR opened"),
  waitingOnAuthor: z.boolean().describe("CI is failing, so the author has to act before a review is worth it"),
  followUp: FollowUpSummarySchema.optional().describe(
    "you reviewed this PR before: what's happened since, and whether a re-review was requested",
  ),
});

export const RankedQueueSchema = z.object({
  schemaVersion: z.literal(QUEUE_SCHEMA_VERSION),
  viewer: z.string(),
  fetchedAt: z.iso.datetime(),
  needsYou: z.array(RankedPullRequestSchema),
  fastTrack: z.array(RankedPullRequestSchema),
  dismissed: z
    .array(RankedPullRequestSchema)
    .optional()
    .describe("PRs you dismissed from the queue; they come back when they change"),
  warnings: z.array(z.string()),
});

export type CiState = z.infer<typeof CiStateSchema>;
export type MajorBump = z.infer<typeof MajorBumpSchema>;
export type PullRequestFacts = z.infer<typeof PullRequestFactsSchema>;
export type Lane = z.infer<typeof LaneSchema>;
export type FastTrackKind = z.infer<typeof FastTrackKindSchema>;
export type RankedPullRequest = z.infer<typeof RankedPullRequestSchema>;
export type RankedQueue = z.infer<typeof RankedQueueSchema>;
export type Score = RankedPullRequest["score"];
