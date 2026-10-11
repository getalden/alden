import { z } from "zod";

/**
 * How you rank your queue: a multiplier on each of the queue's signals, and pinned rules. Plain data on purpose, so
 * the settings page, `alden config` and (later) a model turning "payments first, bots last" into settings all write
 * the same thing. Bump `RANK_SETTINGS_SCHEMA_VERSION` on any breaking change.
 */
export const RANK_SETTINGS_SCHEMA_VERSION = 1;

/**
 * The queue's signals, each a named weight. A weight multiplies the signal's points: 0 ignores it, 1 is the default,
 * 2 doubles it. Failing CI isn't a weight: it always sinks a PR below the others, since the author has to act first.
 */
export const RANK_WEIGHTS = [
  "urgentLabel",
  "stacked",
  "sameAuthor",
  "ownsFiles",
  "waiting",
  "size",
  "risk",
  "noTests",
  "learned",
  "rereview",
] as const;

export const RankWeightSchema = z.enum(RANK_WEIGHTS);

/** The highest multiplier a weight takes. */
export const MAX_RANK_WEIGHT = 10;

const weight = (description: string) =>
  z.number().min(0).max(MAX_RANK_WEIGHT).default(1).describe(`${description} (0 ignores it, 1 is the default)`);

export const RankWeightsSchema = z.object({
  urgentLabel: weight("a label like hotfix, urgent, critical, blocker, p0 or sev1: 6 points"),
  stacked: weight("open PRs built on top of this one: 4 points"),
  sameAuthor: weight("a teammate with several PRs waiting on you: 2 points"),
  ownsFiles: weight("you own changed files through CODEOWNERS: 1 point"),
  waiting: weight("how long you've been asked: 1.5 points after 4 hours, 3 after a day, 4.5 after three days"),
  size: weight("lines to read, lockfiles aside: 1 point past the fast-track size, 2 past 250 lines, 3 past 1,000"),
  risk: weight("sensitive paths (migrations, auth, payments, infra, CI, lockfiles) and major dependency bumps: 2 each"),
  noTests: weight("code changes with no test changes: 1 point"),
  learned: weight("what Alden learned from the PRs you open first or mark useful: up to 3 points either way"),
  rereview: weight("you reviewed it before and were asked again: 2 points"),
});

/** Who wrote a PR, as a rule matches it: a login, or a kind of author. */
export const RULE_AUTHOR_KINDS = ["people", "bots", "agents"] as const;

export const RankRuleWhenSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        'a changed file matches this glob, e.g. "**/payments/**"; a plain "payments/" means that folder anywhere',
      ),
    label: z.string().min(1).optional().describe("the PR has this label (any case)"),
    author: z
      .string()
      .min(1)
      .optional()
      .describe('a login ("sam", "dependabot", "copilot"), or "people", "bots" or "agents" (AI coding agents)'),
    repo: z
      .string()
      .regex(/^[A-Za-z0-9-]+(\/[\w.-]+)?$/, "an organisation, or owner/name for a repo")
      .optional()
      .describe("owner/name, or an organisation for all of its repos"),
    base: z.string().min(1).optional().describe('the branch it merges into, or a glob: "main", "release/*"'),
    title: z.string().min(1).optional().describe("the title contains this (any case)"),
  })
  .refine((when) => Object.values(when).some((v) => v !== undefined), "a rule needs at least one condition")
  .describe("every condition given must hold");

export const RankRuleThenSchema = z.enum(["first", "last", "boost", "lower"]);

/** Points a boost or lower rule moves a PR when it doesn't say: a little under an urgent label. */
export const DEFAULT_RULE_POINTS = 5;

export const RankRuleSchema = z.object({
  when: RankRuleWhenSchema,
  then: RankRuleThenSchema.describe(
    "first: above every PR the rule doesn't match in its lane; last: below them; boost or lower: add or take away points",
  ),
  by: z
    .number()
    .positive()
    .max(50)
    .optional()
    .describe(`points for boost or lower (default ${DEFAULT_RULE_POINTS}); ignored for first and last`),
  name: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe('how the row names the rule: "payments" in "↑ your rule: payments"'),
});

/** `[queue.rank]`: the weights, then `[[queue.rank.rules]]`, applied in order. */
export const RankSettingsSchema = RankWeightsSchema.extend({
  rules: z.array(RankRuleSchema).max(50).default([]).describe("applied after learning, which never overrides them"),
});

/** The line a signal or a rule adds to a PR's score, for `alden queue --explain` and the settings preview. */
export const ScoreLineSchema = z.object({
  signal: z.union([RankWeightSchema, z.literal("rule")]),
  points: z.number().describe("after its weight; 0 for a first or last rule, which orders rather than scores"),
  weight: z.number().optional().describe("the multiplier, when it isn't 1"),
  text: z.string(),
});

/** The Ranking settings as the web UI and desktop app load them: `GET /api/rank`. */
export const RankingStateSchema = z.object({
  path: z.string().describe("the user config they're saved to"),
  settings: RankSettingsSchema,
  prepare: z.number().int().describe("background.prepare: how many top PRs the desktop app keeps briefed"),
  background: z.boolean().describe("background briefings are on (and this is the desktop app, which makes them)"),
});

/** "Top 5 with these settings": the current queue ranked with unsaved settings, `POST /api/rank/preview`. */
export const RankPreviewSchema = z.object({
  fetchedAt: z.iso.datetime().nullable().describe("when the queue it ranks was fetched; null with no queue"),
  needsYou: z.number().int().describe("PRs in Needs you"),
  top: z.array(
    z.object({
      pr: z.string().describe("owner/name#number"),
      title: z.string(),
      url: z.url(),
      author: z.string().nullable(),
      total: z.number(),
      pinned: z.enum(["first", "last"]).optional(),
      was: z.number().int().nullable().describe("its place (1-based) with your saved settings; null if not in the top"),
      reasons: z.array(z.string()),
      breakdown: z.array(ScoreLineSchema),
    }),
  ),
  problem: z.string().optional().describe("why there's no preview, e.g. not signed in"),
});

export type RankWeight = z.infer<typeof RankWeightSchema>;
export type RankWeights = z.infer<typeof RankWeightsSchema>;
export type RankRuleWhen = z.infer<typeof RankRuleWhenSchema>;
export type RankRuleThen = z.infer<typeof RankRuleThenSchema>;
export type RankRule = z.infer<typeof RankRuleSchema>;
export type RankSettings = z.infer<typeof RankSettingsSchema>;
export type ScoreLine = z.infer<typeof ScoreLineSchema>;
export type RankingState = z.infer<typeof RankingStateSchema>;
export type RankPreview = z.infer<typeof RankPreviewSchema>;
