import {
  createGitHubClient,
  type Effort,
  JsonCache,
  loadConfig,
  resolveToken,
  reviewLocalChanges,
  reviewPullRequest,
  SpendLedger,
  selectProvider,
  type TokenSource,
  type WithModel,
} from "@alden/core";
import type { Briefing } from "@alden/schema";
import type { Command } from "commander";
import { describeGitHubError } from "../github-errors.js";
import { parsePrRef } from "../pr-ref.js";
import { startProgress } from "../progress.js";
import { renderBriefing } from "../render/briefing.js";
import { shouldColor } from "../render/style.js";
import { LAST_QUEUE_KEY, type LastQueue } from "./open.js";

interface ReviewOptions {
  json?: boolean;
  /** Commander sets this to false for --no-llm. */
  llm: boolean;
  /** Commander sets this to false for --no-graph. */
  graph: boolean;
  model?: string;
  effort?: string;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export function registerReviewCommand(program: Command): void {
  program
    .command("review")
    .description("Brief you on a PR, or on your local changes when you don't name one.")
    .argument("[pr]", "a PR URL, owner/repo#123, or a # from `alden queue`")
    .option("--no-llm", "run only the deterministic checks, without asking a model")
    .option("--no-graph", "skip the code graph (callers outside the diff)")
    .option("--model <name>", "use this model for this review (e.g. opus), instead of your configured one")
    .option("--effort <level>", "how hard the model thinks: low, medium, high, xhigh or max (default: the model's own)")
    .option("--json", "print the briefing as JSON (see packages/schema/json)")
    .action(async (prArg: string | undefined, options: ReviewOptions) => {
      const config = await loadConfig();
      const effort = options.effort as Effort | undefined;
      if (effort !== undefined && !EFFORTS.includes(effort)) {
        program.error(`--effort must be one of ${EFFORTS.join(", ")}.`);
      }

      let model: WithModel | undefined;
      let unavailable: string | undefined;
      if (options.llm) {
        const choice = selectProvider(config, options.model);
        if (choice.ok) model = { provider: choice.provider, ledger: new SpendLedger(), ...(effort ? { effort } : {}) };
        else unavailable = choice.reason;
      }

      const what = prArg === undefined ? "your local changes" : prArg;
      const progress = startProgress(model ? `Reviewing ${what} with ${model.provider.model}…` : `Checking ${what}…`);
      let briefing: Briefing;
      let source: TokenSource | undefined;
      try {
        if (prArg === undefined) {
          briefing = await reviewLocalChanges(config, process.cwd(), model, { enabled: options.graph });
        } else {
          const last = await new JsonCache().get<LastQueue>(LAST_QUEUE_KEY, 24 * 3_600_000);
          const ref = parsePrRef(prArg, last?.urls);
          const resolved = await resolveToken();
          if (!resolved) {
            progress.stop();
            program.error("Not signed in. Run `alden auth login`.");
          }
          source = resolved.source;
          briefing = await reviewPullRequest(createGitHubClient(resolved.token), ref.repo, ref.number, config, model, {
            enabled: options.graph,
          });
        }
      } catch (error) {
        progress.stop();
        program.error(source ? describeGitHubError(error, source) : (error as Error).message);
      }
      progress.stop();

      if (unavailable && briefing.files.length > 0) {
        briefing = {
          ...briefing,
          llm: { status: "skipped", note: unavailable, findings: [], droppedFindings: 0, omittedFiles: [] },
        };
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
