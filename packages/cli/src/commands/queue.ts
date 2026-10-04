import {
  createGitHubClient,
  fetchReviewQueue,
  JsonCache,
  loadConfig,
  queueEvent,
  queueRows,
  queueScope,
  rankQueue,
  resolveToken,
  track,
} from "@alden/core";
import type { Command } from "commander";
import { describeGitHubError } from "../github-errors.js";
import { learningForQueue } from "../learning.js";
import { nextLine, queueNext, wantsNext } from "../next.js";
import { startProgress } from "../progress.js";
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
      // On stderr, and only on a terminal: scripts read stdout.
      const progress = startProgress("Asking GitHub who you are…");
      let queue: Awaited<ReturnType<typeof fetchReviewQueue>>;
      try {
        queue = await fetchReviewQueue(createGitHubClient(resolved.token), {
          includeDrafts: options.includeDrafts ?? config.queue.includeDrafts,
          limit,
          cache,
          refresh: options.refresh ?? false,
          ...queueScope(config, { repos: options.repo, orgs: options.org }),
          onProgress: (step) => progress.update(`${step}…`),
        });
      } catch (error) {
        progress.stop();
        program.error(describeGitHubError(error, resolved.source));
      }
      progress.update("Seeing what needs your eyes…");
      let ranked: ReturnType<typeof rankQueue>;
      try {
        ranked = rankQueue(queue, config.queue, Date.now(), await learningForQueue(queue));
      } finally {
        progress.stop();
      }
      await track("queue_ranked", queueEvent(ranked));

      const lastQueue: LastQueue = {
        urls: [...ranked.needsYou, ...ranked.fastTrack].map((r) => r.pr.url),
        rows: queueRows(ranked, config.queue),
      };
      await cache.set(LAST_QUEUE_KEY, lastQueue);

      if (options.json) {
        console.log(JSON.stringify(ranked, null, 2));
        return;
      }
      const render = { width: process.stdout.columns ?? 120, color: shouldColor(process.stdout) };
      process.stdout.write(renderQueue(ranked, render));
      if (wantsNext(options.json)) {
        process.stdout.write(
          nextLine(queueNext(lastQueue.urls.length), { ...render, width: Math.min(render.width, 100) }),
        );
      }
    });
}
