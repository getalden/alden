import {
  createGitHubClient,
  fetchReviewQueue,
  formatAge,
  JsonCache,
  loadConfig,
  type RankedPullRequest,
  rankQueue,
  resolveToken,
} from "@alden/core";
import type { Command } from "commander";

function printGroup(title: string, items: RankedPullRequest[], startRank: number): void {
  if (items.length === 0) return;
  console.log(`${title} (${items.length})`);
  items.forEach((item, i) => {
    const { pr } = item;
    // Reasons already lead with "waiting Xd" once it matters; fast-track items show their wait and why they qualify.
    const detail = item.fastTrack
      ? `waiting ${formatAge(item.waitingHours)} · ${item.fastTrack}`
      : item.reasons.join(" · ") || "nothing stands out";
    console.log(`${String(startRank + i).padStart(3)}. ${pr.repo}#${pr.number}  ${pr.title}`);
    console.log(`     @${pr.author ?? "ghost"} · ${detail}`);
  });
  console.log("");
}

export function registerQueueCommand(program: Command): void {
  program
    .command("queue")
    .description("Rank the open PRs waiting on your review.")
    .option("--json", "print the ranked queue as JSON")
    .option("--include-drafts", "include draft PRs")
    .option("--limit <n>", "maximum PRs to fetch", "100")
    .option("--refresh", "ignore the 60-second cache")
    .action(async (options: { json?: boolean; includeDrafts?: boolean; limit: string; refresh?: boolean }) => {
      const resolved = await resolveToken();
      if (!resolved) program.error("Not signed in. Run `alden auth login`.");

      const limit = Number.parseInt(options.limit, 10);
      if (!Number.isInteger(limit) || limit < 1) program.error("--limit must be a positive whole number.");

      const config = await loadConfig();
      const queue = await fetchReviewQueue(createGitHubClient(resolved.token), {
        includeDrafts: options.includeDrafts ?? config.queue.includeDrafts,
        limit,
        cache: new JsonCache(),
        refresh: options.refresh ?? false,
      });
      const ranked = rankQueue(queue, config.queue);

      if (options.json) {
        console.log(JSON.stringify(ranked, null, 2));
        return;
      }

      for (const warning of ranked.warnings) console.warn(`Warning: ${warning}`);
      if (ranked.needsYou.length + ranked.fastTrack.length === 0) {
        console.log(`Nothing is waiting on @${ranked.viewer}'s review.`);
        return;
      }

      printGroup("Needs you", ranked.needsYou, 1);
      printGroup("Fast-track", ranked.fastTrack, ranked.needsYou.length + 1);
    });
}
