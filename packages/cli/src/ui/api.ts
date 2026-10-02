import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  addNote,
  createGitHubClient,
  type Effort,
  editNote,
  FeedbackLog,
  fetchReviewQueue,
  fetchViewer,
  forget,
  forgetAll,
  JsonCache,
  loadConfig,
  loadLearning,
  MODEL_ALIASES,
  memoryItems,
  memoryRepos,
  openStore,
  queueRows,
  rankQueue,
  recordReaction,
  redactFeedback,
  repoFromRemote,
  resolveModel,
  resolveToken,
  restore,
  reviewLocalChanges,
  reviewPullRequest,
  SpendLedger,
  selectProvider,
  setConfigValue,
  setLearning,
  supportsEffort,
  UsageLog,
  unsetConfigValue,
  userConfigPath,
  type WithModel,
} from "@alden/core";
import type { Briefing } from "@alden/schema";
import { LAST_QUEUE_KEY, type LastQueue } from "../commands/open.js";
import { spendReport } from "../commands/spend.js";
import { loadRepoStats } from "../commands/stats.js";
import { describeGitHubError } from "../github-errors.js";
import { learningFor, learningForQueue, noteOpened } from "../learning.js";
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
  // 409, not 401: 401 means the UI's session key is wrong, which the UI handles differently.
  if (!resolved) throw new ApiError(409, "Not signed in to GitHub. Run `alden auth login`, then refresh.");
  return resolved;
}

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

/** The engine, as the UI sees it: the same calls the CLI commands make, with errors worded for a person. */
export function createUiApi(options: { version: string; cwd: string }): UiApi {
  const cache = new JsonCache();
  const feedback = new FeedbackLog();
  /** The repo memory is about: the one asked for, or the clone `alden ui` was started in. */
  const memoryRepo = async (repo?: string) => {
    const target = repo ?? (await repoOf(options.cwd))?.repos[0];
    if (!target || !REPO_NAME.test(target)) {
      throw new ApiError(400, "Start `alden ui` in a clone with a GitHub remote, or pick a repo, to see its memory.");
    }
    return target;
  };
  const memoryOf = async (repo?: string) => {
    const target = await memoryRepo(repo);
    const store = openStore();
    const learning = await loadLearning(store, target);
    return { repo: target, items: memoryItems(learning), paused: learning.paused, path: store.path };
  };

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
        const ranked = rankQueue(queue, config.queue, Date.now(), await learningForQueue(queue));
        // Shared with the CLI, so `alden review 3` means the same PR in both.
        const last: LastQueue = {
          urls: [...ranked.needsYou, ...ranked.fastTrack].map((r) => r.pr.url),
          rows: queueRows(ranked, config.queue),
        };
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
        const learning = await learningFor((await repoOf(options.cwd))?.repos[0]);
        briefing = await reviewLocalChanges(config, options.cwd, model, {
          ...graph,
          ...(learning ? { learning } : {}),
        });
      } else {
        const last = await cache.get<LastQueue>(LAST_QUEUE_KEY, 24 * 3_600_000);
        let ref: ReturnType<typeof parsePrRef>;
        try {
          ref = parsePrRef(request.pr, last?.urls);
        } catch (error) {
          throw new ApiError(400, (error as Error).message);
        }
        const resolved = await signedIn();
        const learning = await learningFor(ref.repo);
        try {
          briefing = await reviewPullRequest(createGitHubClient(resolved.token), ref.repo, ref.number, config, model, {
            ...graph,
            ...(learning ? { learning } : {}),
          });
        } catch (error) {
          throw new ApiError(502, describeGitHubError(error, resolved.source));
        }
        if (briefing.target.kind === "pr") noteOpened(last?.rows, briefing.target.url, "ui");
      }
      // `alden stats` splits before and after at the first use on each repo.
      const usedOn = briefing.target.kind === "pr" ? briefing.target.repo : (await repoOf(options.cwd))?.repos[0];
      if (usedOn) await new UsageLog().markUsed(usedOn).catch(() => {});

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

    async addFeedback(input) {
      try {
        return await feedback.add(input);
      } catch (error) {
        throw new ApiError(
          400,
          `That feedback didn't have the expected shape (${(error as Error).message.slice(0, 200)}).`,
        );
      }
    },

    feedbackSummary: () => feedback.summary(),

    memory: (repo) => memoryOf(repo),

    async memoryRepos() {
      const repos = await memoryRepos(openStore());
      const here = (await repoOf(options.cwd))?.repos[0]?.toLowerCase();
      // The repo alden ui runs in is always listed, even before Alden knows anything there.
      if (here && !repos.some((r) => r.repo === here)) {
        repos.unshift({ repo: here, items: 0, lastChange: "", paused: false });
      }
      return repos;
    },

    async changeMemory(change) {
      const target = await memoryRepo(change.repo);
      const store = openStore();
      try {
        if (change.action === "edit" && !(await editNote(store, target, change.id, change.text))) {
          throw new ApiError(404, `No note called ${change.id} in ${target}.`);
        }
        if (change.action === "restore" && !restore(store, target, change.id)) {
          throw new ApiError(404, `Nothing called ${change.id} was forgotten in ${target}.`);
        }
        if (change.action === "learning") setLearning(store, target, change.on);
        if (change.action === "forget-all") await forgetAll(store, target);
      } catch (error) {
        throw error instanceof ApiError ? error : new ApiError(400, (error as Error).message);
      }
      return memoryOf(target);
    },

    async react({ pr, reaction }) {
      const last = await cache.get<LastQueue>(LAST_QUEUE_KEY, 24 * 3_600_000);
      const row = last?.rows?.find((r) => `${r.repo}#${r.number}`.toLowerCase() === pr.toLowerCase());
      if (!row) throw new ApiError(404, `${pr} isn't in your last queue. Refresh the queue and try again.`);
      recordReaction(openStore(), row, reaction, row.updatedAt ?? new Date().toISOString());
      return { pr, reaction };
    },

    async exportFeedback() {
      return redactFeedback(await feedback.events());
    },

    async addMemory({ repo, text }) {
      const target = await memoryRepo(repo);
      try {
        addNote(openStore(), target, text);
      } catch (error) {
        throw new ApiError(400, (error as Error).message);
      }
      return memoryOf(target);
    },

    async forgetMemory({ repo, id }) {
      const target = await memoryRepo(repo);
      if (!(await forget(openStore(), target, id))) throw new ApiError(404, `Nothing called ${id} in ${target}.`);
      return memoryOf(target);
    },

    async stats({ repo, days, since, refresh }) {
      const target = repo ?? (await repoOf(options.cwd))?.repos[0];
      if (!target) throw new ApiError(400, "Which repo? Start alden ui in a clone of it, or pick one.");
      if (!/^[\w.-]+\/[\w.-]+$/.test(target)) throw new ApiError(400, "A repo is owner/name.");
      if (!Number.isInteger(days) || days < 15 || days > 365) throw new ApiError(400, "days must be 15 to 365.");
      const sinceDate = since ? new Date(`${since}T00:00:00Z`) : undefined;
      if (sinceDate && Number.isNaN(sinceDate.getTime())) throw new ApiError(400, "since must be a date, YYYY-MM-DD.");
      try {
        return await loadRepoStats(target, {
          days,
          horizonDays: 14,
          refresh,
          ...(sinceDate ? { since: sinceDate } : {}),
        });
      } catch (error) {
        throw new ApiError(502, (error as Error).message);
      }
    },

    async setConfig(key, value) {
      try {
        if (value === null) await unsetConfigValue(key);
        else await setConfigValue(key, value);
      } catch (error) {
        throw new ApiError(400, (error as Error).message);
      }
      return { path: userConfigPath(), config: await loadConfig(options.cwd) };
    },
  };
}
