import {
  checkOutcomes,
  createGitHubClient,
  fetchReviewQueue,
  JsonCache,
  loadConfig,
  openStore,
  queueEvent,
  queueRows,
  queueScope,
  rankQueue,
  resolveToken,
  track,
} from "@alden/core";
import {
  activeFilterCount,
  isQueueSort,
  navigateQueue,
  QUEUE_SORTS,
  type QueueFilters,
  type QueueSort,
  type RankedQueue,
} from "@alden/schema";
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
  author?: string;
  label?: string;
  sort?: string;
  search?: string;
  explain?: boolean;
}

const SORT_NAMES: Record<QueueSort, string> = {
  rank: "Alden's rank",
  age: "time open, oldest first",
  waiting: "waiting on you, longest first",
  updated: "last updated",
  size: "size, smallest first",
};

const LOGIN = /^@?[A-Za-z0-9][A-Za-z0-9-]*(\[bot\])?$/;

/** The queue narrowed and re-sorted by --author, --label, --search and --sort, and a line saying so. */
export function narrowQueue(
  ranked: RankedQueue,
  options: Pick<QueueCommandOptions, "author" | "label" | "sort" | "search">,
  now: number,
): { queue: RankedQueue; note: string | undefined } {
  const filters: QueueFilters = {
    ...(options.author ? { author: options.author } : {}),
    ...(options.label ? { label: options.label } : {}),
  };
  const sort: QueueSort = isQueueSort(options.sort) ? options.sort : "rank";
  const search = options.search?.trim() ?? "";
  if (activeFilterCount(filters) === 0 && !search && sort === "rank") return { queue: ranked, note: undefined };
  const view = navigateQueue(ranked, { filters, sort }, { now, search });
  const narrowed = [
    options.author ? `author ${options.author}` : "",
    options.label ? `label ${options.label}` : "",
    search ? `matching "${search}"` : "",
  ].filter(Boolean);
  const parts = [
    narrowed.length ? `${view.shown} of ${view.total} PRs: ${narrowed.join(", ")}` : "",
    sort !== "rank" ? `sorted by ${SORT_NAMES[sort]} within each group` : "",
  ].filter(Boolean);
  return {
    queue: { ...ranked, needsYou: view.needsYou, fastTrack: view.fastTrack, dismissed: view.dismissed },
    note: `${parts.join("; ")}.`.replace(/^./, (c) => c.toUpperCase()),
  };
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
    .option("--author <who>", "only PRs by this login, or by people, bots, agents or you")
    .option("--label <name>", "only PRs with this label")
    .option("--search <text>", "only PRs whose title, repo, #number, author or branch has every word")
    .option("--sort <order>", "rank (default), age, waiting, updated or size; within each group")
    .option("--json", "print the ranked queue as JSON (see packages/schema/json)")
    .option("--explain", "show each PR's score by weight and rule, as [queue.rank] names them")
    .action(async (options: QueueCommandOptions) => {
      const resolved = await resolveToken();
      if (!resolved) program.error("Not signed in. Run `alden auth login`.");

      const limit = Number.parseInt(options.limit, 10);
      if (!Number.isInteger(limit) || limit < 1) program.error("--limit must be a positive whole number.");
      if (options.sort !== undefined && !isQueueSort(options.sort)) {
        program.error(`--sort must be one of ${QUEUE_SORTS.join(", ")}.`);
      }
      if (options.author !== undefined && !LOGIN.test(options.author)) {
        program.error("--author takes a GitHub login, or people, bots, agents or you.");
      }

      const config = await loadConfig();
      const cache = new JsonCache();
      // On stderr, and only on a terminal: scripts read stdout.
      const progress = startProgress("Asking GitHub who you are…");
      const client = createGitHubClient(resolved.token);
      let queue: Awaited<ReturnType<typeof fetchReviewQueue>>;
      try {
        queue = await fetchReviewQueue(client, {
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
      // Once the queue is in: what came of the comments you sent lately (at most a request per PR per day), in the
      // background. Its errors are its own.
      void Promise.resolve()
        .then(() => checkOutcomes(client, openStore()))
        .catch(() => {});
      progress.update("Seeing what needs your eyes…");
      let ranked: ReturnType<typeof rankQueue>;
      try {
        ranked = rankQueue(queue, config.queue, Date.now(), await learningForQueue(queue));
      } finally {
        progress.stop();
      }
      await track("queue_ranked", queueEvent(ranked));

      // `alden open 3` opens the third row shown; learning still sees the whole queue in Alden's order.
      const { queue: shown, note } = narrowQueue(ranked, options, Date.now());
      const lastQueue: LastQueue = {
        urls: [...shown.needsYou, ...shown.fastTrack].map((r) => r.pr.url),
        rows: queueRows(ranked, config.queue),
      };
      await cache.set(LAST_QUEUE_KEY, lastQueue);

      if (options.json) {
        console.log(JSON.stringify(shown, null, 2));
        return;
      }
      const render = { width: process.stdout.columns ?? 120, color: shouldColor(process.stdout) };
      if (note) process.stdout.write(`${note}\n\n`);
      const matched = shown.needsYou.length + shown.fastTrack.length;
      if (note && matched === 0 && ranked.needsYou.length + ranked.fastTrack.length > 0) {
        process.stdout.write("No PRs match. Leave out --author, --label or --search to see them all.\n");
        return;
      }
      process.stdout.write(renderQueue(shown, { ...render, explain: options.explain ?? false }));
      if (wantsNext(options.json)) {
        process.stdout.write(
          nextLine(queueNext(lastQueue.urls.length), { ...render, width: Math.min(render.width, 100) }),
        );
      }
    });
}
