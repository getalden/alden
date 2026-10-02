import { z } from "zod";

/**
 * What Alden learns from and remembers about a reviewer, per repo. Everything stays in the local database
 * (`~/.alden/alden.db`) as append-only events, so a later cloud sync can upload what it hasn't sent yet. Bump
 * `MEMORY_SCHEMA_VERSION` on any breaking change.
 */
export const MEMORY_SCHEMA_VERSION = 1;

/**
 * The reviewer opened a PR from the queue. `position` is where the PR stood among the PRs they hadn't opened yet,
 * ranked without anything learned (0 = the top), so opening something further down says "I care about this more
 * than Alden thought". -1 when it wasn't in the "needs you" lane.
 */
export const OpenEventSchema = z.object({
  schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
  id: z.string(),
  at: z.iso.datetime(),
  repo: z.string().describe("owner/name"),
  number: z.number().int(),
  position: z.number().int().min(-1),
  /** What the PR is about, as learning features: "path:db/migrations/", "author:octocat", "label:api", "kind:dependency". */
  features: z.array(z.string()),
  via: z.enum(["cli", "ui"]),
});

const memoryBase = {
  schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
  id: z.string().describe("the event's own id"),
  at: z.iso.datetime(),
  repo: z.string(),
};

/**
 * Changes to what Alden remembers in a repo: a note added or edited, a note or learned item forgotten or restored,
 * learning paused or resumed.
 */
export const MemoryEventSchema = z.discriminatedUnion("action", [
  z.object({
    ...memoryBase,
    action: z.literal("add"),
    item: z.string().describe("the memory item's id"),
    text: z.string().min(1).max(500),
  }),
  z.object({ ...memoryBase, action: z.literal("edit"), item: z.string(), text: z.string().min(1).max(500) }),
  z.object({
    ...memoryBase,
    action: z.literal("forget"),
    item: z.string().describe("a note's id, or a learned item's stable id"),
  }),
  z.object({ ...memoryBase, action: z.literal("restore"), item: z.string().describe("takes back a forget") }),
  z.object({ ...memoryBase, action: z.literal("pause").describe("stop applying what was learned in this repo") }),
  z.object({ ...memoryBase, action: z.literal("resume") }),
]);

/**
 * A reaction to a PR in the queue: "up" (useful: more like this), "down" (not useful: fewer like this), "dismiss"
 * (hide this PR until it changes), or "clear" to take one back.
 */
export const ReactionEventSchema = z.object({
  schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
  id: z.string(),
  at: z.iso.datetime(),
  repo: z.string(),
  number: z.number().int(),
  reaction: z.enum(["up", "down", "dismiss", "clear"]),
  features: z.array(z.string()),
  /** The PR's updatedAt when dismissed: a later update brings it back. */
  updatedAt: z.iso.datetime(),
});

/** One thing Alden knows about the reviewer in a repo, as the CLI and the UI list it. */
export const MemoryItemSchema = z.object({
  id: z.string().describe("stable: notes have their own, learned items are named after what they're about"),
  repo: z.string(),
  source: z.enum(["you", "learned"]).describe("you wrote it, or Alden learned it from your feedback"),
  kind: z.enum(["note", "check", "queue"]).describe("a note, a check's flags, or how PRs rank in the queue"),
  group: z.enum(["look", "skip"]).describe("what you look for (ranked higher, shown) or what you skip"),
  examples: z.number().int().optional().describe("for learned items: how many reactions it was learned from"),
  text: z.string().describe("what Alden knows, in one sentence"),
  evidence: z.string().optional().describe("for learned items: what it was learned from, e.g. 'agreed 5 of 5 times'"),
  effect: z.string().optional().describe("what it changes, e.g. 'ranks these PRs higher'"),
  since: z.iso.datetime(),
});

export type OpenEvent = z.infer<typeof OpenEventSchema>;
export type MemoryEvent = z.infer<typeof MemoryEventSchema>;
export type MemoryItem = z.infer<typeof MemoryItemSchema>;
export type ReactionEvent = z.infer<typeof ReactionEventSchema>;
