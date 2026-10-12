import { z } from "zod";

/**
 * Usage telemetry: off until you opt in (`alden telemetry on`, the first-run question, or the UI's card). This file
 * is the whole list of what can be sent: every event and every property. Nothing else leaves the machine through it:
 * no code, diffs, titles, paths, repo or user names, notes or tokens. Repos appear only as a salted hash that can't be
 * reversed by hashing public repo names (the salt never leaves your machine), so we can count repos, not name them.
 * Bump `TELEMETRY_SCHEMA_VERSION` on any breaking change.
 */
export const TELEMETRY_SCHEMA_VERSION = 1;

const count = z.number().int().min(0);
const hours = z.number().min(0).nullable();

/** Active minutes on one review, coarsely: the upper bound of each bucket, "60+" for an hour or more. */
export const ACTIVE_MINUTES_BUCKETS = ["0-2", "2-5", "5-10", "10-20", "20-30", "30-60", "60+"] as const;
/** From first opening a briefing to sending the review, coarsely. */
export const WALL_TIME_BUCKETS = ["0-15m", "15-60m", "1-4h", "4-24h", "1-3d", "3d+"] as const;
/** What one model call cost, coarsely, in US dollars; "unpriced" for a model with no known price (a local one). */
export const COST_BUCKETS = ["unpriced", "0-0.01", "0.01-0.05", "0.05-0.25", "0.25+"] as const;

/** Added to every event. */
export const TelemetryCommonSchema = z.object({
  schema: z.literal(TELEMETRY_SCHEMA_VERSION),
  app_version: z.string(),
  surface: z.enum(["cli", "ui", "desktop", "mcp"]).describe("where the event happened; mcp is an AI coding tool"),
  runtime: z.enum(["node", "binary"]),
  os: z.enum(["darwin", "linux", "win32", "other"]),
  arch: z.string(),
  install_age_days: count.describe("days since this install first ran"),
});

export const TelemetryEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("telemetry_enabled"), properties: z.object({}) }),
  z.object({
    event: z.literal("command_run"),
    properties: z.object({
      command: z.enum([
        "queue",
        "open",
        "review",
        "ui",
        "stats",
        "feedback",
        "memory",
        "spend",
        "config",
        "auth",
        "doctor",
        "telemetry",
        "mcp",
        "comment",
        "send",
        "setup",
        "interactive",
        "ask",
        "other",
      ]),
      ok: z.boolean(),
      duration_ms: count,
    }),
  }),
  z.object({
    event: z.literal("queue_ranked"),
    properties: z.object({
      needs_you: count,
      fast_track: count,
      dismissed: count,
      repos: count,
      moved_by_learning: count.describe("rows whose rank your feedback changed"),
    }),
  }),
  z.object({
    event: z.literal("review_completed"),
    properties: z.object({
      target: z.enum(["pr", "local"]),
      repo_hash: z.string().nullable(),
      files: count,
      lines: count,
      languages: z.array(z.string()).describe("code graph languages in the change, e.g. typescript, go"),
      graph: z.boolean().describe("callers outside the diff were looked for"),
      callers: count,
      checks_flagged: count,
      places: count.describe("places to look shown"),
      hidden_by_feedback: count,
      notes_used: count,
      llm_status: z.enum(["none", "ok", "refused", "over_budget", "failed", "truncated", "skipped"]),
      model: z.string().nullable().describe("the model id, e.g. claude-sonnet-5; null without one"),
      usd: z.number().min(0).nullable(),
      duration_ms: count,
    }),
  }),
  z.object({
    event: z.literal("feedback_given"),
    properties: z.object({
      verdict: z.enum(["agree", "not_needed", "dismiss", "clear"]),
      placement: z.enum(["eyes", "finding", "check"]),
      source: z.enum(["check", "llm"]),
      check_id: z.string().nullable().describe("Alden's own check id, e.g. tests.missing"),
    }),
  }),
  z.object({ event: z.literal("missed_reported"), properties: z.object({ has_place: z.boolean() }) }),
  z.object({
    event: z.literal("reaction_given"),
    properties: z.object({ reaction: z.enum(["up", "down", "dismiss", "clear"]) }),
  }),
  z.object({
    event: z.literal("pr_opened"),
    properties: z.object({
      position: z.number().int().min(-1).describe("rank among PRs not opened lately; -1 in fast-track"),
    }),
  }),
  z.object({
    event: z.literal("memory_changed"),
    properties: z.object({
      action: z.enum(["add", "edit", "forget", "restore", "pause", "resume", "forget_all", "exclude", "include"]),
    }),
  }),
  z.object({
    event: z.literal("draft_changed"),
    properties: z.object({
      action: z
        .enum(["add", "edit", "discard", "keep"])
        .describe("keep: you kept one of Alden's drafts as it was, making it yours (editing one makes it yours too)"),
      source: z
        .enum(["you", "claude", "alden"])
        .describe("who wrote the draft: you, Claude Code drafting for you, or Alden drafting from a finding"),
      inline: z.boolean().describe("on a line, rather than a general note"),
    }),
  }),
  z.object({
    event: z.literal("draft_assisted"),
    properties: z.object({
      reply: z.boolean().describe("a reply in a review thread, rather than a comment"),
      inline: z.boolean().describe("on a line, rather than a general note or a reply"),
      edited: z.boolean().describe("you changed Alden's text before saving it"),
    }),
  }),
  z.object({
    event: z.literal("review_sent"),
    properties: z.object({
      review: z.enum(["comment", "approve", "request_changes"]),
      inline: count.describe("comments on lines"),
      notes: count.describe("general notes, sent in the review's body"),
      from_you: count,
      from_claude: count.describe("drafted by Claude Code, then sent by you"),
      has_body: z.boolean().describe("you wrote a review body"),
      unaddressed: count.describe("places Alden flagged that the review didn't comment near"),
    }),
  }),
  z.object({
    event: z.literal("review_signals"),
    properties: z.object({
      source: z.enum(["review", "outcome"]).describe("a review you sent, or what the author did with it afterwards"),
      request_changes: count,
      suggestion: count,
      comment: count,
      silent_pass: count.describe("places you were shown and approved without a comment"),
      miss: count.describe("comments where Alden had flagged nothing"),
      applied: count,
      resolved: count,
    }),
  }),
  z.object({
    event: z.literal("review_timed"),
    properties: z.object({
      active_minutes: z.enum(ACTIVE_MINUTES_BUCKETS).describe("active time on the review, as a bucket of minutes"),
      wall_time: z.enum(WALL_TIME_BUCKETS).describe("first opening the briefing to sending, as a bucket"),
      measured: z
        .boolean()
        .describe("active time measured in the UI; false: from a terminal or AI tool, briefing to send, capped"),
      places_seen: count.describe("places Alden flagged that were in front of you"),
      comments: count.describe("comments and replies sent"),
      model: z.boolean().describe("Alden's model briefed or drafted during the review"),
      verdict: z.enum(["comment", "approve", "request_changes"]),
    }),
  }),
  z.object({
    event: z.literal("tone_set"),
    properties: z.object({
      tone: z.enum(["terse", "concise", "detailed", "teaching"]).nullable().describe("null: a repo's own tone removed"),
      scope: z.enum(["repo", "default"]).describe("one repo's tone on this machine, or the global drafts.tone"),
    }),
  }),
  z.object({
    event: z.literal("question_asked"),
    properties: z.object({
      outcome: z
        .enum(["answered", "refused", "cancelled", "failed"])
        .describe("refused: Alden didn't ask (no model, no briefing, text aimed at AI reviewers, over budget)"),
      cost: z
        .enum(COST_BUCKETS)
        .nullable()
        .describe("what the call cost, as a bucket; null when no call was made or a failed one's cost isn't known"),
      follow_up: z.boolean().describe("earlier questions on the same PR were sent along"),
    }),
  }),
  z.object({
    event: z.literal("stats_viewed"),
    properties: z.object({
      repo_hash: z.string(),
      prs: count,
      split: z.boolean().describe("there's a before and after"),
      first_review_before_h: hours,
      first_review_after_h: hours,
      cycle_before_h: hours,
      cycle_after_h: hours,
    }),
  }),
]);

export type TelemetryCommon = z.infer<typeof TelemetryCommonSchema>;
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
export type TelemetryEventName = TelemetryEvent["event"];
export type TelemetryProperties<E extends TelemetryEventName> = Extract<TelemetryEvent, { event: E }>["properties"];
