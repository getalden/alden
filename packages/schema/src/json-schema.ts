import { z } from "zod";
import { BRIEFING_SCHEMA_VERSION, BriefingSchema } from "./briefing.js";
import { QUEUE_SCHEMA_VERSION, RankedQueueSchema } from "./queue.js";

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
  };
}
