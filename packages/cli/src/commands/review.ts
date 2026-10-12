import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  aldenDraftsLine,
  createGitHubClient,
  type DiffFile,
  type Effort,
  fetchReviewThreads,
  JsonCache,
  loadConfig,
  makeAldenDrafts,
  openReviewSession,
  openStore,
  ReviewDrafts,
  rememberForDrafting,
  repoFromRemote,
  resolveToken,
  reviewEvent,
  reviewLocalChanges,
  reviewPullRequest,
  SpendLedger,
  selectProvider,
  type TokenSource,
  telemetrySurface,
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
      let drafted: string | undefined;
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
          let diff: DiffFile[] | undefined;
          const client = createGitHubClient(resolved.token);
          briefing = await reviewPullRequest(client, ref.repo, ref.number, config, model, {
            enabled: options.graph,
            ...(learning ? { learning } : {}),
            onDiff: (files) => {
              diff = files;
            },
          });
          if (briefing.target.kind === "pr") noteOpened(last?.rows, briefing.target.url, "cli");
          // Its places to look, for `alden send` ("you didn't comment on…") and learning from comments.
          try {
            new ReviewDrafts().rememberBriefing(briefing);
          } catch {
            // the database is locked or damaged: the review still stands
          }
          // Starts (or continues) the PR's review session, for time to review: before Alden's drafts, so they count.
          if (config.stats.reviewTime) {
            try {
              openReviewSession(openStore(), {
                pr: `${ref.repo}#${ref.number}`,
                surface: telemetrySurface(),
                model: briefing.llm?.status === "ok",
              });
            } catch {
              // only the timing is lost
            }
          }
          // What `alden comment <pr> --draft` drafts from.
          await rememberForDrafting(briefing);
          // Comments drafted from the model's findings, kept until you keep, edit or drop them: never sent on their own.
          // Not beside a review thread already on the PR; drafted as before when the threads can't be read.
          try {
            const threads =
              config.drafts.auto && briefing.llm?.status === "ok"
                ? (await fetchReviewThreads(client, ref.repo, ref.number, "").catch(() => undefined))?.threads
                : undefined;
            const { made } = makeAldenDrafts(briefing, diff, {
              enabled: config.drafts.auto,
              ...(threads ? { threads } : {}),
            });
            drafted = aldenDraftsLine(made.length, `${ref.repo}#${ref.number}`);
          } catch {
            // the review stands without drafts
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
        if (drafted) console.error(drafted);
        return;
      }
      if (options.markdown) {
        process.stdout.write(briefingMarkdown(briefing));
        if (drafted) console.error(drafted);
        return;
      }
      const render = { width: Math.min(process.stdout.columns ?? 100, 120), color: shouldColor(process.stdout) };
      process.stdout.write(renderBriefing(briefing, render));
      if (drafted) process.stdout.write(`\n${drafted}\n`);
      if (wantsNext(options.json)) {
        const rank =
          prArg !== undefined && /^#?\d+$/.test(prArg.trim()) ? Number(prArg.trim().replace("#", "")) : undefined;
        process.stdout.write(nextLine(reviewNext(briefing, rank), render));
      }
    });
}
