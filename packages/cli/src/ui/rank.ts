import { loadConfig, type RankChange, type ReviewQueue, rankQueue, setRankSettings, userConfigPath } from "@alden/core";
import {
  type AldenConfig,
  type RankingState,
  type RankPreview,
  type RankRule,
  RankSettingsSchema,
  type RankWeight,
} from "@alden/schema";
import { learningForQueue } from "../learning.js";
import { ApiError } from "./server.js";

/** How many PRs the settings preview shows. */
export const PREVIEW_TOP = 5;

/** The Ranking section of Settings: your weights, rules and how many PRs to keep briefed, and a preview. */
export interface RankingApi {
  state(): Promise<RankingState>;
  save(change: RankChange): Promise<RankingState>;
  /** The current queue ranked with these (unsaved) settings, beside where each PR sits with the saved ones. */
  preview(settings: { weights?: Partial<Record<RankWeight, number>>; rules?: RankRule[] }): Promise<RankPreview>;
}

export interface RankingApiOptions {
  cwd: string;
  desktop: boolean;
  /** The queue to preview: the last one fetched if there is one, else a fresh one. Throws when there's none to be had. */
  queue(config: AldenConfig): Promise<ReviewQueue>;
  /** What was learned, per repo; from the local database unless given (the UI demo has its own). */
  learning?: typeof learningForQueue;
}

export function createRankingApi(options: RankingApiOptions): RankingApi {
  const state = async (): Promise<RankingState> => {
    const config = await loadConfig(options.cwd);
    return {
      path: userConfigPath(),
      settings: config.queue.rank,
      prepare: config.background.prepare,
      background: options.desktop && config.background.enabled,
    };
  };

  return {
    state,

    async save(change) {
      try {
        await setRankSettings(change);
      } catch (error) {
        throw new ApiError(400, (error as Error).message);
      }
      return state();
    },

    async preview(input) {
      const config = await loadConfig(options.cwd);
      const parsed = RankSettingsSchema.safeParse({
        ...config.queue.rank,
        ...input.weights,
        rules: input.rules ?? config.queue.rank.rules,
      });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ApiError(400, `${issue?.path.join(".") || "Ranking"}: ${issue?.message ?? "not valid"}`);
      }
      let queue: ReviewQueue;
      try {
        queue = await options.queue(config);
      } catch (error) {
        return { fetchedAt: null, needsYou: 0, top: [], problem: (error as Error).message };
      }
      const now = Date.now();
      const learning = await (options.learning ?? learningForQueue)(queue);
      const saved = rankQueue(queue, config.queue, now, learning);
      const trying = rankQueue(queue, { ...config.queue, rank: parsed.data }, now, learning);
      const place = new Map(saved.needsYou.map((r, i) => [r.pr.url, i + 1]));
      return {
        fetchedAt: queue.fetchedAt,
        needsYou: trying.needsYou.length,
        top: trying.needsYou.slice(0, PREVIEW_TOP).map((r) => ({
          pr: `${r.pr.repo}#${r.pr.number}`,
          title: r.pr.title,
          url: r.pr.url,
          author: r.pr.author,
          total: r.score.total,
          ...(r.pinned ? { pinned: r.pinned } : {}),
          was: place.get(r.pr.url) ?? null,
          reasons: r.reasons,
          breakdown: r.breakdown ?? [],
        })),
      };
    },
  };
}
