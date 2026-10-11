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
      action: z.enum(["add", "edit", "discard"]),
      source: z
        .enum(["you", "claude", "alden"])
        .describe("who wrote the draft: you, Claude Code drafting for you, or Alden drafting from a finding"),
      inline: z.boolean().describe("on a line, rather than a general note"),
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
