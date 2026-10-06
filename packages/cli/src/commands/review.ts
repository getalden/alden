import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createGitHubClient,
  type Effort,
  JsonCache,
  loadConfig,
  ReviewDrafts,
  repoFromRemote,
  resolveToken,
  reviewEvent,
  reviewLocalChanges,
  reviewPullRequest,
  SpendLedger,
  selectProvider,
  type TokenSource,
  track,
  UsageLog,
  type WithModel,
} from "@alden/core";
import type { Briefing } from "@alden/schema";
import type { Command } from "commander";
import { describeGitHubError } from "../github-errors.js";
import { learningFor, noteOpened } from "../learning.js";
import { nextLine, reviewNext, wantsNext } from "../next.js";
import { parsePrRef, queuePick } from "../pr-ref.js";
import { startProgress } from "../progress.js";
import { renderBriefing } from "../render/briefing.js";
import { briefingMarkdown } from "../render/markdown.js";
import { shouldColor } from "../render/style.js";
import { LAST_QUEUE_KEY, type LastQueue } from "./open.js";

interface ReviewOptions {
  json?: boolean;
  markdown?: boolean;
  /** Commander sets this to false for --no-llm. */
  llm: boolean;
  /** Commander sets this to false for --no-graph. */
  graph: boolean;
  model?: string;
  effort?: string;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** The GitHub repo a clone's `origin` points at, if any. */
async function originRepo(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)("git", ["remote", "get-url", "origin"], { cwd: root });
    return repoFromRemote(stdout);
  } catch {
    return undefined;
  }
}

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
    .option("--markdown", "print the briefing as a Markdown document to share or save (`> briefing.md`)")
    .action(async (prArg: string | undefined, options: ReviewOptions) => {
      const startedAt = Date.now();
      if (options.json && options.markdown) program.error("Choose one of --json and --markdown.");
      const config = await loadConfig();
      const effort = options.effort as Effort | undefined;
      if (effort !== undefined && !EFFORTS.includes(effort)) {
        program.error(`--effort must be one of ${EFFORTS.join(", ")}.`);
      }

      let model: WithModel | undefined;
      let unavailable: string | undefined;
      if (options.llm) {
        const choice = await selectProvider(config, options.model);
        if (choice.ok) model = { provider: choice.provider, ledger: new SpendLedger(), ...(effort ? { effort } : {}) };
        else unavailable = choice.reason;
      }

      const what = prArg === undefined ? "your local changes" : prArg;
      const progress = startProgress(model ? `Reviewing ${what} with ${model.provider.model}…` : `Checking ${what}…`);
      let briefing: Briefing;
      let source: TokenSource | undefined;
      let picked: string | undefined;
      try {
        if (prArg === undefined) {
          const learning = await learningFor(await originRepo(process.cwd()));
          briefing = await reviewLocalChanges(config, process.cwd(), model, {
            enabled: options.graph,
            ...(learning ? { learning } : {}),
          });
        } else {
          const last = await new JsonCache().get<LastQueue>(LAST_QUEUE_KEY, 24 * 3_600_000);
          const ref = parsePrRef(prArg, last?.urls);
          // A bare number is a place in the last queue, which isn't the PR with that number: say which PR it was.
          if (/^#?\d+$/.test(prArg.trim())) picked = queuePick(prArg, ref, await originRepo(process.cwd()));
          const resolved = await resolveToken();
          if (!resolved) {
            progress.stop();
            program.error("Not signed in. Run `alden auth login`.");
          }
          source = resolved.source;
          const learning = await learningFor(ref.repo);
          briefing = await reviewPullRequest(createGitHubClient(resolved.token), ref.repo, ref.number, config, model, {
            enabled: options.graph,
            ...(learning ? { learning } : {}),
          });
          if (briefing.target.kind === "pr") noteOpened(last?.rows, briefing.target.url, "cli");
          // Its places to look, for `alden send` ("you didn't comment on…") and learning from comments.
          try {
            new ReviewDrafts().rememberBriefing(briefing);
          } catch {
            // the database is locked or damaged: the review still stands
          }
        }
      } catch (error) {
        progress.stop();
        program.error(source ? describeGitHubError(error, source) : (error as Error).message);
      }
      progress.stop();
      if (picked) console.error(picked);
      // `alden stats` splits before and after at the first use on each repo.
      const usedOn = briefing.target.kind === "pr" ? briefing.target.repo : await originRepo(briefing.target.repoRoot);
      if (usedOn) await new UsageLog().markUsed(usedOn).catch(() => {});
      await track(
        "review_completed",
        reviewEvent(briefing, { durationMs: Date.now() - startedAt, repo: usedOn, graph: options.graph }),
      );

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
      if (options.markdown) {
        process.stdout.write(briefingMarkdown(briefing));
        return;
      }
      const render = { width: Math.min(process.stdout.columns ?? 100, 120), color: shouldColor(process.stdout) };
      process.stdout.write(renderBriefing(briefing, render));
      if (wantsNext(options.json)) {
        const rank =
          prArg !== undefined && /^#?\d+$/.test(prArg.trim()) ? Number(prArg.trim().replace("#", "")) : undefined;
        process.stdout.write(nextLine(reviewNext(briefing, rank), render));
      }
    });
}
