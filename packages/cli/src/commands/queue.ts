import { createGitHubClient, fetchReviewQueue, JsonCache, loadConfig, rankQueue, resolveToken } from "@alden/core";
import type { Command } from "commander";
import { describeGitHubError } from "../github-errors.js";
import { renderQueue, shouldColor } from "../render/queue.js";
import { LAST_QUEUE_KEY, type LastQueue } from "./open.js";

const collect = (value: string, previous: string[]) => [...previous, value];

interface QueueCommandOptions {
  json?: boolean;
  includeDrafts?: boolean;
  limit: string;
  refresh?: boolean;
  repo: string[];
  org: string[];
}

export function registerQueueCommand(program: Command): void {
  program
    .command("queue")
    .description("Rank the open PRs waiting on your review.")
    .option("--repo <owner/name>", "only this repo (repeat for more)", collect, [])
    .option("--org <name>", "only repos in this organisation (repeat for more)", collect, [])
    .option("--limit <n>", "maximum PRs to fetch", "100")
    .option("--include-drafts", "include draft PRs")
    .option("--refresh", "ignore the 60-second cache")
    .option("--json", "print the ranked queue as JSON (see packages/schema/json)")
    .action(async (options: QueueCommandOptions) => {
      const resolved = await resolveToken();
      if (!resolved) program.error("Not signed in. Run `alden auth login`.");

      const limit = Number.parseInt(options.limit, 10);
      if (!Number.isInteger(limit) || limit < 1) program.error("--limit must be a positive whole number.");

      const config = await loadConfig();
      const cache = new JsonCache();
      let queue: Awaited<ReturnType<typeof fetchReviewQueue>>;
      try {
        queue = await fetchReviewQueue(createGitHubClient(resolved.token), {
          includeDrafts: options.includeDrafts ?? config.queue.includeDrafts,
          limit,
          cache,
          refresh: options.refresh ?? false,
          repos: options.repo,
          orgs: options.org,
        });
      } catch (error) {
        program.error(describeGitHubError(error, resolved.source));
      }
      const ranked = rankQueue(queue, config.queue);

      const lastQueue: LastQueue = { urls: [...ranked.needsYou, ...ranked.fastTrack].map((r) => r.pr.url) };
      await cache.set(LAST_QUEUE_KEY, lastQueue);

      if (options.json) {
        console.log(JSON.stringify(ranked, null, 2));
        return;
      }
      process.stdout.write(
        renderQueue(ranked, { width: process.stdout.columns ?? 120, color: shouldColor(process.stdout) }),
      );
    });
}
