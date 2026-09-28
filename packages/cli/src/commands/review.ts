import {
  createGitHubClient,
  JsonCache,
  loadConfig,
  resolveToken,
  reviewLocalChanges,
  reviewPullRequest,
} from "@alden/core";
import type { Command } from "commander";
import { parsePrRef } from "../pr-ref.js";
import { renderBriefing } from "../render/briefing.js";
import { shouldColor } from "../render/style.js";
import { LAST_QUEUE_KEY, type LastQueue } from "./open.js";

export function registerReviewCommand(program: Command): void {
  program
    .command("review")
    .description("Brief you on a PR, or on your local changes when you don't name one.")
    .argument("[pr]", "a PR URL, owner/repo#123, or a # from `alden queue`")
    .option("--json", "print the briefing as JSON (see packages/schema/json)")
    .action(async (prArg: string | undefined, options: { json?: boolean }) => {
      const config = await loadConfig();
      let briefing: Awaited<ReturnType<typeof reviewLocalChanges>>;
      try {
        if (prArg === undefined) {
          briefing = await reviewLocalChanges(config);
        } else {
          const last = await new JsonCache().get<LastQueue>(LAST_QUEUE_KEY, 24 * 3_600_000);
          const ref = parsePrRef(prArg, last?.urls);
          const resolved = await resolveToken();
          if (!resolved) program.error("Not signed in. Run `alden auth login`.");
          briefing = await reviewPullRequest(createGitHubClient(resolved.token), ref.repo, ref.number, config);
        }
      } catch (error) {
        program.error((error as Error).message);
      }

      if (options.json) {
        console.log(JSON.stringify(briefing, null, 2));
        return;
      }
      process.stdout.write(
        renderBriefing(briefing, {
          width: Math.min(process.stdout.columns ?? 100, 120),
          color: shouldColor(process.stdout),
        }),
      );
    });
}
