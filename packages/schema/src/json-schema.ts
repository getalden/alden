import { z } from "zod";
import { BRIEFING_SCHEMA_VERSION, BriefingSchema } from "./briefing.js";
import { FEEDBACK_SCHEMA_VERSION, FeedbackEventSchema } from "./feedback.js";
import { QUEUE_SCHEMA_VERSION, RankedQueueSchema } from "./queue.js";
import { RepoStatsSchema, STATS_SCHEMA_VERSION } from "./stats.js";

/** JSON Schema documents published with Alden, keyed by file name. Regenerate with `pnpm schema:generate`. */
export function jsonSchemas(): Record<string, unknown> {
  return {
    [`ranked-queue.v${QUEUE_SCHEMA_VERSION}.json`]: {
      $id: `https://getalden.dev/schema/ranked-queue.v${QUEUE_SCHEMA_VERSION}.json`,
      title: "Alden ranked review queue",
      ...z.toJSONSchema(RankedQueueSchema, { target: "draft-2020-12" }),
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
    [`repo-stats.v${STATS_SCHEMA_VERSION}.json`]: {
      $id: `https://getalden.dev/schema/repo-stats.v${STATS_SCHEMA_VERSION}.json`,
      title: "Alden repo review stats",
      ...z.toJSONSchema(RepoStatsSchema, { target: "draft-2020-12" }),
    },
  };
}
