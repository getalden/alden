import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createGitHubClient,
  type Effort,
  fetchReviewQueue,
  fetchViewer,
  JsonCache,
  loadConfig,
  MODEL_ALIASES,
  rankQueue,
  repoFromRemote,
  resolveModel,
  resolveToken,
  reviewLocalChanges,
  reviewPullRequest,
  SpendLedger,
  selectProvider,
  setConfigValue,
  supportsEffort,
  userConfigPath,
  type WithModel,
} from "@alden/core";
import type { Briefing } from "@alden/schema";
import { LAST_QUEUE_KEY, type LastQueue } from "../commands/open.js";
import { spendReport } from "../commands/spend.js";
import { describeGitHubError } from "../github-errors.js";
import { parsePrRef } from "../pr-ref.js";
import { ApiError, type UiApi } from "./server.js";

const run = promisify(execFile);
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** The GitHub repos the directory `alden ui` started in points at: where PR reviews can find callers. */
async function repoOf(cwd: string): Promise<{ root: string; repos: string[] } | undefined> {
  try {
    const { stdout: root } = await run("git", ["rev-parse", "--show-toplevel"], { cwd });
    const { stdout: remotes } = await run("git", ["remote", "-v"], { cwd });
    const repos = [...new Set(remotes.split("\n").flatMap((l) => repoFromRemote(l.split(/\s+/)[1] ?? "") ?? []))];
    return { root: root.trim(), repos };
  } catch {
    return undefined;
  }
}

async function signedIn() {
  const resolved = await resolveToken();
  if (!resolved) throw new ApiError(401, "Not signed in to GitHub. Run `alden auth login`, then refresh.");
  return resolved;
}

/** The engine, as the UI sees it: the same calls the CLI commands make, with errors worded for a person. */
export function createUiApi(options: { version: string; cwd: string }): UiApi {
  const cache = new JsonCache();

  return {
    async session() {
      const config = await loadConfig(options.cwd);
      const resolved = await resolveToken();
      let user: { login: string; source: string } | { error: string } | null = null;
      if (resolved) {
        try {
          const { viewer } = await fetchViewer(createGitHubClient(resolved.token));
          user = { login: viewer.login, source: resolved.source };
        } catch (error) {
          user = { error: describeGitHubError(error, resolved.source) };
        }
      }
      const choice = selectProvider(config);
      const resolvedModel = resolveModel(config.model.name);
      const ledger = new SpendLedger();
      return {
        version: options.version,
        cwd: options.cwd,
        repo: (await repoOf(options.cwd)) ?? null,
        user,
        model: {
          provider: config.model.provider,
          name: config.model.name,
          id: resolvedModel,
          effort: config.model.effort ?? null,
          supportsEffort: config.model.provider !== "openai-compatible" && supportsEffort(resolvedModel),
          available: choice.ok,
          ...(choice.ok ? {} : { reason: choice.reason }),
        },
        aliases: MODEL_ALIASES,
        efforts: EFFORTS,
        budget: {
          perReviewUsd: config.budget.perReviewUsd,
          dailyUsd: config.budget.dailyUsd,
          spentToday: await ledger.spentOn(),
        },
      };
    },

    async queue({ refresh, repos, orgs }) {
      const resolved = await signedIn();
      const config = await loadConfig(options.cwd);
      try {
        const queue = await fetchReviewQueue(createGitHubClient(resolved.token), {
          includeDrafts: config.queue.includeDrafts,
          limit: 100,
          cache,
          refresh,
          repos,
          orgs,
        });
        const ranked = rankQueue(queue, config.queue);
        // Shared with the CLI, so `alden review 3` means the same PR in both.
        const last: LastQueue = { urls: [...ranked.needsYou, ...ranked.fastTrack].map((r) => r.pr.url) };
        await cache.set(LAST_QUEUE_KEY, last);
        return ranked;
      } catch (error) {
        throw new ApiError(502, describeGitHubError(error, resolved.source));
      }
    },

    async review(request, onStage): Promise<Briefing> {
      const config = await loadConfig(options.cwd);
      const effort = request.effort as Effort | undefined;
      if (effort !== undefined && !EFFORTS.includes(effort)) {
        throw new ApiError(400, `effort must be one of ${EFFORTS.join(", ")}.`);
      }
      let model: WithModel | undefined;
      let unavailable: string | undefined;
      if (request.llm !== false) {
        const choice = selectProvider(config, request.model);
        if (choice.ok) model = { provider: choice.provider, ledger: new SpendLedger(), ...(effort ? { effort } : {}) };
        else unavailable = choice.reason;
      }
      const graph = { enabled: request.graph !== false, cwd: options.cwd, onStage };

      let briefing: Briefing;
      if (request.pr === undefined) {
        briefing = await reviewLocalChanges(config, options.cwd, model, graph);
      } else {
        const last = await cache.get<LastQueue>(LAST_QUEUE_KEY, 24 * 3_600_000);
        let ref: ReturnType<typeof parsePrRef>;
        try {
          ref = parsePrRef(request.pr, last?.urls);
        } catch (error) {
          throw new ApiError(400, (error as Error).message);
        }
        const resolved = await signedIn();
        try {
          briefing = await reviewPullRequest(
            createGitHubClient(resolved.token),
            ref.repo,
            ref.number,
            config,
            model,
            graph,
          );
        } catch (error) {
          throw new ApiError(502, describeGitHubError(error, resolved.source));
        }
      }
      if (unavailable && briefing.files.length > 0 && !briefing.llm) {
        briefing = {
          ...briefing,
          llm: { status: "skipped", note: unavailable, findings: [], droppedFindings: 0, omittedFiles: [] },
        };
      }
      return briefing;
    },

    async spend() {
      const config = await loadConfig(options.cwd);
      return spendReport(new SpendLedger(), config.budget);
    },

    async config() {
      return { path: userConfigPath(), config: await loadConfig(options.cwd) };
    },

    async setConfig(key, value) {
      try {
        await setConfigValue(key, value);
      } catch (error) {
        throw new ApiError(400, (error as Error).message);
      }
      return { path: userConfigPath(), config: await loadConfig(options.cwd) };
    },
  };
}
