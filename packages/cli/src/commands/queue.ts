import { createGitHubClient, fetchReviewQueue, JsonCache, type PullRequestFacts, resolveToken } from "@alden/core";
import type { Command } from "commander";

function waiting(pr: PullRequestFacts, now: number): string {
  const since = Date.parse(pr.request.requestedAt ?? pr.createdAt);
  const hours = Math.max(0, Math.round((now - since) / 3_600_000));
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function via(pr: PullRequestFacts): string {
  if (pr.request.direct) return "you";
  if (pr.request.teams.length > 0) return pr.request.teams.join(", ");
  return "team";
}

export function registerQueueCommand(program: Command): void {
  program
    .command("queue")
    .description("List the open PRs waiting on your review.")
    .option("--json", "print the raw facts as JSON")
    .option("--include-drafts", "include draft PRs")
    .option("--limit <n>", "maximum PRs to fetch", "100")
    .option("--refresh", "ignore the 60-second cache")
    .action(async (options: { json?: boolean; includeDrafts?: boolean; limit: string; refresh?: boolean }) => {
      const resolved = await resolveToken();
      if (!resolved) program.error("Not signed in. Run `alden auth login`.");

      const limit = Number.parseInt(options.limit, 10);
      if (!Number.isInteger(limit) || limit < 1) program.error("--limit must be a positive whole number.");

      const queue = await fetchReviewQueue(createGitHubClient(resolved.token), {
        includeDrafts: options.includeDrafts ?? false,
        limit,
        cache: new JsonCache(),
        refresh: options.refresh ?? false,
      });

      if (options.json) {
        console.log(JSON.stringify(queue, null, 2));
        return;
      }

      for (const warning of queue.warnings) console.warn(`Warning: ${warning}`);
      if (queue.pullRequests.length === 0) {
        console.log(`Nothing is waiting on @${queue.viewer}'s review.`);
        return;
      }

      const now = Date.now();
      console.log(`${queue.pullRequests.length} PRs waiting on @${queue.viewer}'s review (unranked until day 4):\n`);
      for (const pr of queue.pullRequests) {
        const size = `+${pr.additions}/-${pr.deletions}`;
        const owned = pr.codeownedFiles.length > 0 ? " · you own files" : "";
        console.log(`${pr.repo}#${pr.number}  ${pr.title}`);
        console.log(
          `  @${pr.author ?? "ghost"} · waiting ${waiting(pr, now)} · via ${via(pr)} · ${size} · CI ${pr.ci}${owned}`,
        );
      }
    });
}
