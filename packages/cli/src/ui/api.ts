import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  addNote,
  backgroundModelAllowed,
  cachedReviewQueue,
  checkProgress,
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
  queueEvent,
  queueRows,
  queueScope,
  type ReviewQueue,
  rankQueue,
  reactionProgress,
  recordReaction,
  repoFromRemote,
  resolveModel,
  resolveToken,
  restore,
  reviewEvent,
  reviewLocalChanges,
  reviewPullRequest,
  SpendLedger,
  selectProvider,
  setConfigValue,
  setLearning,
  setTelemetryConsent,
  supportsEffort,
  telemetryBlocked,
  telemetryConsent,
  track,
  UsageLog,
  unsetConfigValue,
  userConfigPath,
  type WithModel,
} from "@alden/core";
import type { Briefing, RankedQueue } from "@alden/schema";
import { LAST_QUEUE_KEY, type LastQueue } from "../commands/open.js";
import { spendReport } from "../commands/spend.js";
import { loadRepoStats } from "../commands/stats.js";
import { describeGitHubError } from "../github-errors.js";
import { learningFor, learningForQueue, noteOpened } from "../learning.js";
import { parsePrRef } from "../pr-ref.js";
import { ApiError, type ReviewRequest, type UiApi } from "./server.js";
import { cliStatus, createSignIn, gitHubCliSignedIn, installCli } from "./setup.js";

const run = promisify(execFile);
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** The GitHub repos the directory `alden ui` started in points at: where PR reviews can find callers. */
export async function repoOf(cwd: string): Promise<{ root: string; repos: string[] } | undefined> {
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

/** A briefing made in the background, and the PR's last update it was made from (newer pushes make it stale). */
interface Prepared {
  briefing: Briefing;
  updatedAt: string;
  at: string;
}

/**
 * PRs the UI fetches: all of them, up to the 1,000 a GitHub search can return, so the repo filter covers the whole
 * queue rather than its first page.
 */
export const UI_QUEUE_LIMIT = 1000;

/** How many of the top "needs you" PRs the desktop app prepares briefings for. */
const PREPARE_TOP = 3;

/**
 * The PR to brief in the background next: the first of the top "needs you" PRs that's ready for review (not a draft,
 * not waiting on its author) and has no briefing for its latest update.
 */
export function nextToPrepare(
  queue: RankedQueue,
  preparedFor: (repo: string, number: number) => string | undefined,
): RankedQueue["needsYou"][number] | undefined {
  return queue.needsYou
    .slice(0, PREPARE_TOP)
    .find(
      (row) => !row.waitingOnAuthor && !row.pr.isDraft && preparedFor(row.pr.repo, row.pr.number) !== row.pr.updatedAt,
    );
}

/**
 * The engine, as the UI sees it: the same calls the CLI commands make, with errors worded for a person. `desktop` is
 * set when the desktop app runs it, which turns on background briefings.
 */
export function createUiApi(options: { version: string; cwd: string; desktop?: boolean }): UiApi {
  const cache = new JsonCache();
  const feedback = new FeedbackLog();
  const prepared = new Map<string, Prepared>();
  const signIn = createSignIn();
  const keyOf = (repo: string, number: number) => `${repo}#${number}`.toLowerCase();
  /** Queue fetches under way, so the window, the menu bar and background briefings share one. */
  const fetching = new Map<string, Promise<ReviewQueue>>();
  const shared = (key: string, fetch: () => Promise<ReviewQueue>) => {
    const running = fetching.get(key) ?? fetch().finally(() => fetching.delete(key));
    fetching.set(key, running);
    return running;
  };
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

  const api: UiApi = {
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
        desktop: options.desktop === true,
        signIn: { source: resolved?.source ?? null, gitHubCli: await gitHubCliSignedIn() },
        queueScope: queueScope(config),
        eyes: config.review.eyes,
        ...(options.desktop ? { cli: cliStatus() } : {}),
        background: { enabled: config.background.enabled, model: await backgroundModelAllowed() },
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

    async queue({ refresh, repos, orgs, cached = false }) {
      const resolved = await signedIn();
      const config = await loadConfig(options.cwd);
      try {
        const client = createGitHubClient(resolved.token);
        const scope = {
          includeDrafts: config.queue.includeDrafts,
          limit: UI_QUEUE_LIMIT,
          cache,
          ...queueScope(config, { repos, orgs }),
        };
        // `cached`: the last queue, up to a day old, at once; the UI shows its age and asks again for a fresh one.
        const queue =
          (cached ? await cachedReviewQueue(client, scope) : undefined) ??
          (await shared(JSON.stringify([scope.repos, scope.orgs, scope.ignore, refresh]), () =>
            fetchReviewQueue(client, { ...scope, refresh }),
          ));
        const ranked = rankQueue(queue, config.queue, Date.now(), await learningForQueue(queue));
        void track("queue_ranked", queueEvent(ranked));
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

    review: (request, onStage) => runReview(request, onStage, false),

    async startSignIn() {
      try {
        return await signIn.start();
      } catch (error) {
        throw new ApiError(502, (error as Error).message);
      }
    },
    signInStatus: async () => signIn.status(),
    async openSignIn() {
      signIn.open();
      return signIn.status();
    },
    useGitHubCli: () => signIn.useGitHubCli(),
    cliStatus: async () => cliStatus(),
    async installCli() {
      if (!options.desktop) throw new ApiError(400, "Only the desktop app installs the alden command.");
      return installCli();
    },

    async prepareNext() {
      const config = await loadConfig(options.cwd);
      if (!options.desktop || !config.background.enabled) return { prepared: null, reason: "off" };
      const queue = (await api.queue({ refresh: false, repos: [], orgs: [] })) as RankedQueue;
      const next = nextToPrepare(queue, (repo, number) => prepared.get(keyOf(repo, number))?.updatedAt);
      if (!next) return { prepared: null, reason: "up to date" };
      const { pr } = next;
      const llm = await backgroundModelAllowed();
      const briefing = await runReview({ pr: `${pr.repo}#${pr.number}`, llm, graph: true }, () => {}, true);
      const entry = { briefing, updatedAt: pr.updatedAt, at: new Date().toISOString() };
      prepared.set(keyOf(pr.repo, pr.number), entry);
      return {
        prepared: {
          pr: `${pr.repo}#${pr.number}`,
          title: pr.title,
          places: briefing.needsYourEyes.length,
          model: briefing.llm?.status === "ok",
          at: entry.at,
        },
      };
    },

    async prepared(pr) {
      if (pr === undefined) {
        return [...prepared.values()].flatMap(({ briefing, updatedAt, at }) =>
          briefing.target.kind === "pr"
            ? [{ pr: `${briefing.target.repo}#${briefing.target.number}`, updatedAt, at }]
            : [],
        );
      }
      const entry = prepared.get(pr.toLowerCase());
      if (!entry) return null;
      // Stale once the PR has changed since: the last queue knows its latest update.
      const last = await cache.get<LastQueue>(LAST_QUEUE_KEY, 24 * 3_600_000);
      const row = last?.rows?.find((r) => keyOf(r.repo, r.number) === pr.toLowerCase());
      if (row?.updatedAt && row.updatedAt !== entry.updatedAt) {
        prepared.delete(pr.toLowerCase());
        return null;
      }
      // Reading it is using Alden on that repo, for `alden stats`, and opening that PR, for learning.
      const target = entry.briefing.target;
      if (target.kind === "pr") {
        await new UsageLog().markUsed(target.repo).catch(() => {});
        noteOpened(last?.rows, target.url, "ui");
      }
      return { briefing: entry.briefing, at: entry.at };
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
        const event = await feedback.add(input);
        if (event.kind === "missed") void track("missed_reported", { has_place: event.anchor !== undefined });
        else {
          void track("feedback_given", {
            verdict: event.verdict,
            placement: event.item.placement,
            source: event.item.source,
            check_id: event.item.checkId ?? null,
          });
          // How close this brought a lesson, so learning is never invisible while it builds.
          if (event.target.repo) {
            const progress = checkProgress(
              await loadLearning(openStore(), event.target.repo),
              event.item,
              event.verdict,
            );
            if (progress) return { ...event, progress };
          }
        }
        return event;
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
      const action =
        change.action === "learning"
          ? change.on
            ? "resume"
            : "pause"
          : change.action === "forget-all"
            ? "forget_all"
            : change.action;
      void track("memory_changed", { action });
      return memoryOf(target);
    },

    async react({ pr, reaction }) {
      const last = await cache.get<LastQueue>(LAST_QUEUE_KEY, 24 * 3_600_000);
      const row = last?.rows?.find((r) => `${r.repo}#${r.number}`.toLowerCase() === pr.toLowerCase());
      if (!row) throw new ApiError(404, `${pr} isn't in your last queue. Refresh the queue and try again.`);
      const store = openStore();
      recordReaction(store, row, reaction, row.updatedAt ?? new Date().toISOString());
      void track("reaction_given", { reaction });
      const progress = reactionProgress(await loadLearning(store, row.repo), row.features, reaction);
      return { pr, reaction, ...(progress ? { progress } : {}) };
    },

    async telemetry() {
      return { consent: await telemetryConsent(), blocked: telemetryBlocked() ?? null };
    },

    async setTelemetry(on) {
      await setTelemetryConsent(on);
      return { consent: await telemetryConsent(), blocked: telemetryBlocked() ?? null };
    },

    async exportFeedback() {
      return feedback.redacted();
    },

    async addMemory({ repo, text }) {
      const target = await memoryRepo(repo);
      try {
        addNote(openStore(), target, text);
      } catch (error) {
        throw new ApiError(400, (error as Error).message);
      }
      void track("memory_changed", { action: "add" });
      return memoryOf(target);
    },

    async forgetMemory({ repo, id }) {
      const target = await memoryRepo(repo);
      if (!(await forget(openStore(), target, id))) throw new ApiError(404, `Nothing called ${id} in ${target}.`);
      void track("memory_changed", { action: "forget" });
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

  /** One review, for the UI or (background) for the desktop app ahead of time, which isn't you opening the PR. */
  async function runReview(
    request: ReviewRequest,
    onStage: Parameters<UiApi["review"]>[1],
    background: boolean,
  ): Promise<Briefing> {
    const startedAt = Date.now();
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
      if (!background && briefing.target.kind === "pr") noteOpened(last?.rows, briefing.target.url, "ui");
    }
    // `alden stats` splits before and after at the first use on each repo (a background briefing counts when read).
    const usedOn = briefing.target.kind === "pr" ? briefing.target.repo : (await repoOf(options.cwd))?.repos[0];
    if (usedOn && !background) await new UsageLog().markUsed(usedOn).catch(() => {});
    void track(
      "review_completed",
      reviewEvent(briefing, { durationMs: Date.now() - startedAt, repo: usedOn, graph: request.graph !== false }),
    );

    if (unavailable && briefing.files.length > 0 && !briefing.llm) {
      briefing = {
        ...briefing,
        llm: { status: "skipped", note: unavailable, findings: [], droppedFindings: 0, omittedFiles: [] },
      };
    }
    return briefing;
  }

  return api;
}
