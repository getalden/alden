import { z } from "zod";
import { BRIEFING_SCHEMA_VERSION, BriefingSchema } from "./briefing.js";
import { FEEDBACK_SCHEMA_VERSION, FeedbackEventSchema } from "./feedback.js";
import { MEMORY_SCHEMA_VERSION, MemoryItemSchema } from "./memory.js";
import { QUEUE_SCHEMA_VERSION, RankedQueueSchema } from "./queue.js";
import { RANK_SETTINGS_SCHEMA_VERSION, RankSettingsSchema } from "./rank.js";
import { REVIEW_SCHEMA_VERSION, ReviewDraftSchema } from "./review.js";
import { RepoStatsSchema, STATS_SCHEMA_VERSION } from "./stats.js";
import { TELEMETRY_SCHEMA_VERSION, TelemetryCommonSchema, TelemetryEventSchema } from "./telemetry.js";

/** JSON Schema documents published with Alden, keyed by file name. Regenerate with `pnpm schema:generate`. */
export function jsonSchemas(): Record<string, unknown> {
  return {
    [`ranked-queue.v${QUEUE_SCHEMA_VERSION}.json`]: {
      $id: `https://getalden.dev/schema/ranked-queue.v${QUEUE_SCHEMA_VERSION}.json`,
      title: "Alden ranked review queue",
      ...z.toJSONSchema(RankedQueueSchema, { target: "draft-2020-12" }),
    },
    [`rank-settings.v${RANK_SETTINGS_SCHEMA_VERSION}.json`]: {
      $id: `https://getalden.dev/schema/rank-settings.v${RANK_SETTINGS_SCHEMA_VERSION}.json`,
      title: "Alden queue ranking settings ([queue.rank] in config.toml)",
      ...z.toJSONSchema(RankSettingsSchema, { target: "draft-2020-12", io: "input" }),
    },
    [`briefing.v${BRIEFING_SCHEMA_VERSION}.json`]: {
      $id: `https://getalden.dev/schema/briefing.v${BRIEFING_SCHEMA_VERSION}.json`,
      title: "Alden briefing",
      ...z.toJSONSchema(BriefingSchema, { target: "draft-2020-12" }),
    },
    [`feedback-event.v${FEEDBACK_SCHEMA_VERSION}.json`]: {
      $id: `https://getalden.dev/schema/feedback-event.v${FEEDBACK_SCHEMA_VERSION}.json`,
      title: "Alden feedback event",
      ...z.toJSONSchema(FeedbackEventSchema, { target: "draft-2020-12" }),
    },
    [`memory-item.v${MEMORY_SCHEMA_VERSION}.json`]: {
      $id: `https://getalden.dev/schema/memory-item.v${MEMORY_SCHEMA_VERSION}.json`,
      title: "Alden memory item",
      ...z.toJSONSchema(MemoryItemSchema, { target: "draft-2020-12" }),
    },
    [`telemetry-event.v${TELEMETRY_SCHEMA_VERSION}.json`]: {
      $id: `https://getalden.dev/schema/telemetry-event.v${TELEMETRY_SCHEMA_VERSION}.json`,
      title: "Alden telemetry event (only sent if you opt in)",
      ...z.toJSONSchema(z.object({ common: TelemetryCommonSchema, event: TelemetryEventSchema }), {
        target: "draft-2020-12",
      }),
    },
    [`repo-stats.v${STATS_SCHEMA_VERSION}.json`]: {
      $id: `https://getalden.dev/schema/repo-stats.v${STATS_SCHEMA_VERSION}.json`,
      title: "Alden repo review stats",
      ...z.toJSONSchema(RepoStatsSchema, { target: "draft-2020-12" }),
    },
    [`review-draft.v${REVIEW_SCHEMA_VERSION}.json`]: {
      $id: `https://getalden.dev/schema/review-draft.v${REVIEW_SCHEMA_VERSION}.json`,
      title: "Alden review draft (a comment waiting to be sent)",
      ...z.toJSONSchema(ReviewDraftSchema, { target: "draft-2020-12" }),
    },
  };
}
