import {
  type Learning,
  loadLearning,
  openStore,
  type QueueRow,
  type RankedQueue,
  type ReviewQueue,
  recordOpen,
  track,
} from "@alden/core";

/**
 * Learning never stops a command: if the local database can't be opened (a locked or damaged file), Alden ranks and
 * reviews as if it had learned nothing, and says so once.
 */
let warned = false;
function unavailable(error: unknown): undefined {
  if (!warned) {
    warned = true;
    console.error(`Alden couldn't read what it has learned (${(error as Error).message}); carrying on without it.`);
  }
  return undefined;
}

export async function learningFor(repo: string | undefined): Promise<Learning | undefined> {
  if (!repo) return undefined;
  try {
    return await loadLearning(openStore(), repo);
  } catch (error) {
    return unavailable(error);
  }
}

/** Learning for every repo in a queue, keyed by lowercased owner/name, for `rankQueue`. */
export async function learningForQueue(queue: ReviewQueue): Promise<(repo: string) => Learning | undefined> {
  const repos = [...new Set(queue.pullRequests.map((pr) => pr.repo.toLowerCase()))];
  const learned = new Map<string, Learning | undefined>();
  for (const repo of repos) learned.set(repo, await learningFor(repo));
  return (repo) => learned.get(repo.toLowerCase());
}

/** Notes that you opened the PR at `url`, when it was in the queue you last saw. */
export function noteOpened(rows: QueueRow[] | undefined, url: string, via: "cli" | "ui"): void {
  const row = rows?.find((r) => r.url === url);
  if (!row || !rows) return;
  try {
    const opened = recordOpen(openStore(), rows, row, via);
    if (opened) void track("pr_opened", { position: opened.position });
  } catch (error) {
    unavailable(error);
  }
}

export type { RankedQueue };
