import { z } from "zod";

/**
 * What happens on a PR after you review it: replies to your comments, threads resolved, and a second review requested.
 * Alden reads it from GitHub (read only), shows it on the queue and in the briefing, and the desktop app notifies you at
 * the level you chose, globally or per PR. Bump `FOLLOW_UPS_SCHEMA_VERSION` on any breaking change.
 */
export const FOLLOW_UPS_SCHEMA_VERSION = 1;

/**
 * How much Alden pings you about a PR you reviewed:
 * - off: never (the queue row still shows the state)
 * - rereview: only when a second review is requested from you or your team
 * - your-turn: a re-review is requested, or every comment you left is resolved or has a reply
 * - every-reply: each new reply, resolve or re-request, and a push that makes one of your threads outdated
 */
export const FollowUpLevelSchema = z.enum(["off", "rereview", "your-turn", "every-reply"]);

export const ReviewThreadCommentSchema = z.object({
  id: z.string().describe("the comment's GraphQL node id"),
  databaseId: z.number().int().nullable().describe("the comment's REST id"),
  author: z.string().nullable().describe("null when the account was deleted"),
  isYou: z.boolean().describe("the viewer wrote it"),
  body: z.string(),
  createdAt: z.iso.datetime(),
  url: z.string(),
});

/** One review thread on a PR, as GitHub keeps it: a line (or file) comment and its replies. */
export const ReviewThreadSchema = z.object({
  id: z.string().describe("the thread's GraphQL node id: what a reply's `inReplyTo` names"),
  path: z.string(),
  line: z.number().int().positive().nullable().describe("the line at the PR's head; null when the thread is outdated"),
  startLine: z.number().int().positive().nullable(),
  originalLine: z.number().int().positive().nullable().describe("the line when the thread was started"),
  side: z.enum(["LEFT", "RIGHT"]),
  isResolved: z.boolean(),
  isOutdated: z.boolean().describe("the code it's on has changed since"),
  startedByYou: z.boolean(),
  viewerCanReply: z.boolean(),
  viewerCanResolve: z.boolean(),
  comments: z.array(ReviewThreadCommentSchema).describe("oldest first; the first started the thread"),
});

export const ReviewThreadsSchema = z.object({
  schemaVersion: z.literal(FOLLOW_UPS_SCHEMA_VERSION),
  pr: z.string().describe('"owner/repo#123"'),
  headSha: z.string(),
  viewer: z.string(),
  threads: z.array(ReviewThreadSchema),
});

/** The state of a PR you reviewed, for the queue row and the briefing header. */
export const FollowUpSummarySchema = z.object({
  pr: z.string().describe('"owner/repo#123"'),
  lastReviewedAt: z.iso.datetime().describe("when you last submitted a review"),
  lastReviewedHead: z.string().optional().describe("the head commit you last reviewed, when known"),
  commitsSince: z.number().int().min(0).optional().describe("commits pushed since your last review"),
  rereviewRequestedAt: z.iso.datetime().optional().describe("a review was requested from you after your last one"),
  yourThreads: z.number().int().min(0).describe("threads you started"),
  resolved: z.number().int().min(0).describe("of yours, resolved"),
  replied: z
    .number()
    .int()
    .min(0)
    .describe("of yours, unresolved but with a reply from someone else after your last word"),
});

export const FollowUpEventKindSchema = z.enum(["rereview", "reply", "resolved", "outdated", "your-turn"]);

/** Something that happened on a PR you reviewed. Recorded once; `notified` once the desktop app has shown it. */
export const FollowUpEventSchema = z.object({
  id: z.string().describe("stable: the same happening always has the same id, so it's recorded once"),
  pr: z.string().describe('"owner/repo#123"'),
  title: z.string(),
  url: z.string(),
  kind: FollowUpEventKindSchema,
  at: z.iso.datetime(),
  text: z.string().describe("one plain line, e.g. 'Ana replied to your comment on src/pay.ts:40'"),
});

/** One notification: every event a check found on one PR, already filtered by that PR's level. */
export const FollowUpNotificationSchema = z.object({
  pr: z.string(),
  title: z.string(),
  url: z.string(),
  text: z.string().describe("one line for the notification body, e.g. '2 replies, 1 resolved'"),
  events: z.array(z.string()).describe("the event ids it covers, to acknowledge"),
});

export const FollowUpNotificationsSchema = z.object({
  notifications: z.array(FollowUpNotificationSchema),
  sound: z
    .boolean()
    .optional()
    .describe("`notifications.sound`: whether the desktop app plays the system's sound with them"),
});

/** A PR's notification level: its own override, or the global setting. */
export const PrWatchSchema = z.object({
  pr: z.string(),
  override: FollowUpLevelSchema.optional().describe("absent: the PR follows the global setting"),
  level: FollowUpLevelSchema.describe("what applies: the override, else the global setting"),
});

export type FollowUpLevel = z.infer<typeof FollowUpLevelSchema>;
export type ReviewThreadComment = z.infer<typeof ReviewThreadCommentSchema>;
export type ReviewThread = z.infer<typeof ReviewThreadSchema>;
export type ReviewThreads = z.infer<typeof ReviewThreadsSchema>;
export type FollowUpSummary = z.infer<typeof FollowUpSummarySchema>;
export type FollowUpEventKind = z.infer<typeof FollowUpEventKindSchema>;
export type FollowUpEvent = z.infer<typeof FollowUpEventSchema>;
export type FollowUpNotification = z.infer<typeof FollowUpNotificationSchema>;
export type FollowUpNotifications = z.infer<typeof FollowUpNotificationsSchema>;
export type PrWatch = z.infer<typeof PrWatchSchema>;
