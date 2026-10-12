import {
  type AldenStore,
  type createGitHubClient,
  fetchReviewQueue,
  fillFollowUpCounts,
  followUpRows,
  type JsonCache,
  openStore,
  queueEvent,
  queueScope,
  rankQueue,
  refreshFollowUps,
  track,
  withYourTurn,
} from "@alden/core";
import type { AldenConfig, RankedQueue } from "@alden/schema";
import { learningForQueue } from "./learning.js";
import { checkSentOutcomes } from "./outcomes.js";

/** How long the queue waits for the follow-up check before it shows what's stored (the check still finishes). */
export const FOLLOW_UP_WAIT_MS = 8_000;

/** GitHub wouldn't give the queue: `cause` is its error, for `describeGitHubError`. */
export class QueueFetchError extends Error {
  constructor(override readonly cause: unknown) {
    super((cause as Error)?.message ?? String(cause));
  }
}

/**
 * The queue as `alden queue` and the interactive view load it: fetched (saying what it's doing), ranked with what
 * Alden has learned, the PRs you reviewed checked for follow-ups, and the Your turn group added. Counted as
 * `queue_ranked`. A failed fetch throws `QueueFetchError`; the follow-up check never fails the queue.
 */
export async function loadRankedQueue(
  client: ReturnType<typeof createGitHubClient>,
  config: AldenConfig,
  options: {
    cache: JsonCache;
    limit: number;
    refresh: boolean;
    includeDrafts?: boolean;
    repos?: string[];
    orgs?: string[];
    onProgress: (label: string) => void;
  },
): Promise<RankedQueue> {
  const scope = queueScope(config, { repos: options.repos ?? [], orgs: options.orgs ?? [] });
  let queue: Awaited<ReturnType<typeof fetchReviewQueue>>;
  try {
    queue = await fetchReviewQueue(client, {
      includeDrafts: options.includeDrafts ?? config.queue.includeDrafts,
      limit: options.limit,
      cache: options.cache,
      refresh: options.refresh,
      ...scope,
      onProgress: (step) => options.onProgress(`${step}…`),
    });
  } catch (error) {
    throw new QueueFetchError(error);
  }
  // Once the queue is in: what came of the comments you sent lately (at most a request per PR per day), in the
  // background. Its errors are its own.
  void Promise.resolve()
    .then(() => checkSentOutcomes(client, openStore()))
    .catch(() => {});
  options.onProgress("Seeing what needs your eyes…");
  let ranked = rankQueue(queue, config.queue, Date.now(), await learningForQueue(queue));
  // What happened on the PRs you reviewed: the follow-up check the desktop app runs, with its limits (only PRs GitHub
  // says changed, at most once a minute). Never fails the queue: what's stored still shows.
  let store: AldenStore | undefined;
  try {
    store = openStore();
  } catch {
    // the database is locked or damaged: the queue still stands
  }
  if (store) {
    const global = config.notifications.followUps;
    options.onProgress("Checking the PRs you reviewed…");
    await refreshFollowUps(client, store, { global, queue: followUpRows(ranked), waitMs: FOLLOW_UP_WAIT_MS });
    try {
      ranked = withYourTurn(store, fillFollowUpCounts(store, ranked), { global, scope });
    } catch {
      // as above
    }
  }
  await track("queue_ranked", queueEvent(ranked));
  return ranked;
}
