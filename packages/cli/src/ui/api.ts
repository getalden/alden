import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import {
  addActiveTime,
  addNote,
  backgroundModelAllowed,
  briefingForDrafting,
  cachedReviewQueue,
  checkFreshness,
  checkLinkTarget,
  checkModelKey,
  checkProgress,
  checkThread,
  cloneAt,
  createGitHubClient,
  DiffCache,
  type DiffFile,
  DraftingError,
  draftReview,
  dropAldenDrafts,
  type Effort,
  editNote,
  FeedbackLog,
  fetchPullRequest,
  fetchPullRequestState,
  fetchReviewQueue,
  fetchReviewThreads,
  fetchViewer,
  findClone,
  forget,
  forgetAll,
  JsonCache,
  keepAldenDrafts,
  loadConfig,
  loadLearning,
  localDiffView,
  MODEL_ALIASES,
  makeAldenDrafts,
  memoryItems,
  memoryRepos,
  modelKeyStore,
  noteModelUsed,
  openReviewSession,
  openStore,
  type Placement,
  placeOrLink,
  prName,
  publicDraft,
  pullRequestDiffView,
  queueEvent,
  queueRows,
  queueScope,
  ReviewDrafts,
  type ReviewQueue,
  rankQueue,
  reactionProgress,
  recordReaction,
  recordSeen,
  rememberForDrafting,
  resolveModel,
  resolveModelKey,
  resolveToken,
  restore,
  reviewEvent,
  reviewLocalChanges,
  reviewPullRequest,
  reviewTimedEvent,
  reviewTimeStats,
  SendReviewError,
  SpendLedger,
  scopeNote,
  seenPlaces,
  selectProvider,
  sendReview,
  sentComments,
  setConfigValue,
  setLearning,
  setTelemetryConsent,
  suggestCommentText,
  supportsEffort,
  telemetryBlocked,
  telemetryConsent,
  telemetrySurface,
  track,
  UsageLog,
  unaddressedPlaces,
  unsetConfigValue,
  userConfigPath,
  type WithModel,
  whyNoToken,
} from "@alden/core";
import type {
  AldenConfig,
  Briefing,
  BriefingFreshness,
  BriefingTarget,
  DraftLink,
  RankedQueue,
  ReviewDraft,
  ReviewThreads,
} from "@alden/schema";
import { LAST_QUEUE_KEY, type LastQueue, openInBrowser } from "../commands/open.js";
import { spendReport } from "../commands/spend.js";
import { loadRepoStats } from "../commands/stats.js";
import { describeGitHubError, reviewWriteFix } from "../github-errors.js";
import { learningFor, learningForQueue, noteOpened } from "../learning.js";
import { checkSentOutcomes } from "../outcomes.js";
import { parsePrRef } from "../pr-ref.js";
import { briefingFileName, briefingMarkdown } from "../render/markdown.js";
import { createFollowUpsApi } from "./follow-ups.js";
import { createModelSetupApi } from "./model-setup.js";
import { createRankingApi } from "./rank.js";
import { ApiError, type DraftInput, type ReviewRequest, type UiApi } from "./server.js";
import { cliStatus, createSignIn, gitHubCliSignedIn, installCli } from "./setup.js";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** How long a PR's review threads are kept: the drawer, the Diff tab and a reply's check then share one read. */
export const THREADS_TTL_MS = 30_000;

/** The GitHub repos the directory `alden ui` started in points at: where PR reviews can find callers. */
export function repoOf(cwd: string): Promise<{ root: string; repos: string[] } | undefined> {
  return cloneAt(cwd);
}

async function signedIn() {
  const resolved = await resolveToken();
  // 409, not 401: 401 means the UI's session key is wrong, which the UI handles differently.
  if (!resolved) throw new ApiError(409, "Not signed in to GitHub. Run `alden auth login`, then refresh.");
  return resolved;
}

/**
 * Writes an exported briefing to the Downloads folder without replacing anything there: a second export of the same PR
 * becomes "…-briefing-2.md", as a browser names a repeat download. The Tauri window can't download files itself.
 */
export async function saveToDownloads(
  name: string,
  text: string,
  folder = join(homedir(), "Downloads"),
): Promise<{ path: string; shown: string }> {
  await mkdir(folder, { recursive: true });
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; n <= 100; n++) {
    const path = join(folder, n === 1 ? name : `${stem}-${n}${ext}`);
    try {
      await writeFile(path, text, { encoding: "utf8", flag: "wx" });
      const home = homedir();
      return { path, shown: path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ApiError(500, `Couldn't save the briefing in ${folder}: ${(error as Error).message}`);
      }
    }
  }
  throw new ApiError(409, `${folder} already has 100 copies of ${name}. Move some, then save again.`);
}

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

/**
 * A briefing made in the background, and the PR's last update it was made from. It's stale once the PR has a new push
 * or (for callers from the merge) its base branch has moved: see `checkFreshness`.
 */
interface Prepared {
  briefing: Briefing;
  updatedAt: string;
  at: string;
  /** When its head and base were last compared with GitHub's (ms). */
  checkedAt: number;
}

/** While you're away, how often a prepared briefing's head and base are compared with GitHub's again: one request. */
const RECHECK_PREPARED_MS = 5 * 60_000;

/**
 * PRs the UI fetches: all of them, up to the 1,000 a GitHub search can return, so the repo filter covers the whole
 * queue rather than its first page.
 */
export const UI_QUEUE_LIMIT = 1000;

/** How many of the top "needs you" PRs the desktop app prepares briefings for, unless `background.prepare` says. */
const PREPARE_TOP = 3;

/**
 * The PR to brief in the background next: the first of the top `top` "needs you" PRs, in your ranked order (your
 * weights and rules included), that's ready for review (not a draft, not waiting on its author) and has no briefing
 * for its latest update. Briefings found stale (a moved base doesn't change `updatedAt`) are dropped before this
 * runs, so their PRs come up again.
 */
export function nextToPrepare(
  queue: RankedQueue,
  preparedFor: (repo: string, number: number) => string | undefined,
  top: number = PREPARE_TOP,
): RankedQueue["needsYou"][number] | undefined {
  return queue.needsYou
    .slice(0, top)
    .find(
      (row) => !row.waitingOnAuthor && !row.pr.isDraft && preparedFor(row.pr.repo, row.pr.number) !== row.pr.updatedAt,
    );
}

/**
 * The engine, as the UI sees it: the same calls the CLI commands make, with errors worded for a person. `desktop` is
 * set when the desktop app runs it, which turns on background briefings.
 */
export function createUiApi(options: {
  version: string;
  cwd: string;
  desktop?: boolean;
  /** Where the desktop app saves exported briefings: ~/Downloads, or a temporary folder in tests. */
  downloads?: string;
}): UiApi {
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
  /** A PR as typed (URL, owner/repo#12 or a queue number), named as drafts name it. */
  const prOf = async (pr: string) => {
    const last = await cache.get<LastQueue>(LAST_QUEUE_KEY, 24 * 3_600_000);
    try {
      const ref = parsePrRef(pr, last?.urls);
      return { ...ref, name: prName(ref.repo, ref.number) };
    } catch (error) {
      throw new ApiError(400, (error as Error).message);
    }
  };
  /** A PR's head and diff from GitHub, with its drafts brought up to that head. */
  const followPr = async (ref: { repo: string; number: number; name: string }) => {
    const resolved = await signedIn();
    const client = createGitHubClient(resolved.token);
    try {
      const state = await fetchPullRequestState(client, ref.repo, ref.number);
      drafts.follow(ref.name, state.headSha, state.files);
      return { ...state, client, source: resolved.source };
    } catch (error) {
      throw new ApiError(502, describeGitHubError(error, resolved.source));
    }
  };
  const drafts = new ReviewDrafts();
  /** PRs' review threads as last read, by PR: each answer carries the head it's of. Dropped once a review is sent. */
  const threadsRead = new Map<string, { at: number; threads: ReviewThreads }>();
  /** Your login, for marking your comments in threads: asked once per sign-in. */
  let viewer: { token: string; login: string } | undefined;
  const threadsOf = async (ref: { repo: string; number: number; name: string }, refresh = false) => {
    const key = ref.name.toLowerCase();
    const hit = threadsRead.get(key);
    if (!refresh && hit && Date.now() - hit.at < THREADS_TTL_MS) return hit.threads;
    const resolved = await signedIn();
    const client = createGitHubClient(resolved.token);
    let found: ReviewThreads | undefined;
    try {
      if (viewer?.token !== resolved.token) {
        const { data } = await client.request("GET /user");
        viewer = { token: resolved.token, login: data.login };
      }
      found = await fetchReviewThreads(client, ref.repo, ref.number, viewer.login);
    } catch (error) {
      throw new ApiError(502, describeGitHubError(error, resolved.source));
    }
    if (!found) throw new ApiError(404, `${ref.name} isn't on GitHub, or your sign-in can't see it.`);
    threadsRead.set(key, { at: Date.now(), threads: found });
    return found;
  };
  /** Checks a reply's thread is on the PR and GitHub lets you reply there (with text) and resolve it (when ticked). */
  const checkReplyThread = async (
    ref: { repo: string; number: number; name: string },
    threadId: string,
    want: { reply: boolean; resolve: boolean },
  ) => {
    const threads = await threadsOf(ref);
    try {
      checkThread(threads, threadId, want);
    } catch (error) {
      throw new ApiError(422, (error as Error).message);
    }
    return threads;
  };
  const followUps = createFollowUpsApi({ cwd: options.cwd, signedIn, prRef: prOf });
  /**
   * Where a comment on `path` goes: inline when GitHub takes it on the diff, otherwise a note in the review body
   * linking to the code at the PR's head, once GitHub confirms the file (and line) are there to link to.
   */
  const spotFor = async (
    client: ReturnType<typeof createGitHubClient>,
    ref: { repo: string },
    headSha: string,
    files: Parameters<typeof placeOrLink>[0],
    at: {
      path: string;
      line?: number | undefined;
      startLine?: number | undefined;
      side?: "RIGHT" | "LEFT" | undefined;
    },
  ): Promise<{ place: Placement } | { linkTo: DraftLink }> => {
    const spot = placeOrLink(files, at.path, at.line, at.side ?? "RIGHT", at.startLine);
    if ("problem" in spot) throw new ApiError(422, spot.problem);
    if ("linkTo" in spot) {
      const missing = await checkLinkTarget(client, ref.repo, headSha, spot.linkTo);
      if (missing) throw new ApiError(422, missing);
    }
    return spot;
  };
  /** The Diff tab's diffs, per PR and head commit, for as long as `alden ui` runs. */
  const diffs = new DiffCache();
  const inline = (d: { path?: string | undefined }) => d.path !== undefined;
  const memoryOf = async (repo?: string) => {
    const target = await memoryRepo(repo);
    const store = openStore();
    const learning = await loadLearning(store, target);
    return { repo: target, items: memoryItems(learning), paused: learning.paused, path: store.path };
  };

  /** Whether a PR briefing still matches the PR on GitHub. */
  const freshNow = async (target: BriefingTarget): Promise<BriefingFreshness> => {
    const resolved = await signedIn();
    return checkFreshness(createGitHubClient(resolved.token), target);
  };
  /**
   * Drops background briefings of PRs in the queue that no longer match the PR (a new push, or a moved base), checking
   * each at most every few minutes. A failed check keeps the briefing; the queue's update time still applies.
   */
  const dropStalePrepared = async (queue: RankedQueue) => {
    const now = Date.now();
    for (const row of queue.needsYou) {
      const key = keyOf(row.pr.repo, row.pr.number);
      const entry = prepared.get(key);
      if (!entry || entry.updatedAt !== row.pr.updatedAt || now - entry.checkedAt < RECHECK_PREPARED_MS) continue;
      const fresh = await freshNow(entry.briefing.target).catch(() => undefined);
      if (!fresh) continue;
      if (fresh.state === "fresh") entry.checkedAt = now;
      else prepared.delete(key);
    }
  };

  /** A drafting failure as the UI shows it, with what the call cost when one was made. */
  const draftingProblem = (error: unknown): unknown => {
    if (!(error instanceof DraftingError)) return error;
    const cost = error.usd !== undefined && error.usd > 0 ? ` That call cost $${error.usd.toFixed(4)}.` : "";
    const status = error.kind === "failed" || error.kind === "refused" ? 502 : 409;
    return new ApiError(status, `${error.message}${cost}`);
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
      const choice = await selectProvider(config);
      const resolvedModel = resolveModel(config.model.name);
      const ledger = new SpendLedger();
      return {
        version: options.version,
        cwd: options.cwd,
        desktop: options.desktop === true,
        signIn: {
          source: resolved?.source ?? null,
          gitHubCli: await gitHubCliSignedIn(),
          // Signed out: why, so "I've signed in" can say what failed rather than ask again.
          ...(resolved ? {} : { problem: await whyNoToken() }),
        },
        queueScope: queueScope(config),
        eyes: config.review.eyes,
        ...(options.desktop ? { cli: cliStatus() } : {}),
        background: { enabled: config.background.enabled, model: await backgroundModelAllowed() },
        notifications: { sound: config.notifications.sound, followUps: config.notifications.followUps },
        learning: { fromReviews: config.learning.fromReviews },
        drafts: { auto: config.drafts.auto },
        stats: { reviewTime: config.stats.reviewTime },
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
          // Where the Anthropic key comes from; never the key.
          key: choice.ok && choice.key ? { source: choice.key.source, where: choice.key.where } : null,
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
        const fresh = rankQueue(queue, config.queue, Date.now(), await learningForQueue(queue));
        // A fresh queue checks the PRs you reviewed for news first (only those GitHub says changed, at most once a
        // minute); a cached one shows what the last check found.
        if (!cached) await followUps.refresh(fresh);
        // Rows you reviewed before get their thread counts and news; the other PRs with news make Your turn.
        const ranked = await followUps.noteQueue(fresh, scope);
        void track("queue_ranked", queueEvent(ranked));
        // What came of the comments you sent lately, after the queue is in: at most a request per PR per day.
        if (!cached) {
          void Promise.resolve()
            .then(() => checkSentOutcomes(client, openStore()))
            .catch(() => {});
        }
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
    async setModelKey(key) {
      const store = modelKeyStore();
      if (key === null) await store.delete();
      else {
        const trimmed = key.trim();
        const problem = checkModelKey(trimmed);
        if (problem) throw new ApiError(400, problem);
        try {
          await store.set(trimmed);
        } catch (error) {
          throw new ApiError(500, `Couldn't store the key (${(error as Error).message.slice(0, 160)}).`);
        }
      }
      const now = await resolveModelKey();
      return { key: now ? { source: now.source, where: now.where } : null };
    },

    modelSetup: createModelSetupApi({ cwd: options.cwd }),

    followUps,

    ranking: createRankingApi({
      cwd: options.cwd,
      desktop: options.desktop === true,
      // The queue you last saw, as the Queue view fetched it; a fresh one only if there's none yet.
      async queue(config) {
        const resolved = await signedIn();
        const client = createGitHubClient(resolved.token);
        const scope = {
          includeDrafts: config.queue.includeDrafts,
          limit: UI_QUEUE_LIMIT,
          cache,
          ...queueScope(config),
        };
        try {
          return (
            (await cachedReviewQueue(client, scope)) ??
            (await shared(JSON.stringify([scope.repos, scope.orgs, scope.ignore, false]), () =>
              fetchReviewQueue(client, { ...scope, refresh: false }),
            ))
          );
        } catch (error) {
          throw new ApiError(502, describeGitHubError(error, resolved.source));
        }
      },
    }),

    async clone(repo) {
      const config = await loadConfig(options.cwd);
      const found = await findClone(repo, { cwd: options.cwd, folders: config.clones.folders }).catch(() => undefined);
      return { repo, path: found?.path ?? null, how: found?.how ?? null };
    },

    cliStatus: async () => cliStatus(),
    async saveBriefing(briefing) {
      if (!options.desktop) throw new ApiError(400, "Only the desktop app saves briefings; a browser downloads them.");
      return saveToDownloads(briefingFileName(briefing), briefingMarkdown(briefing), options.downloads);
    },
    async installCli() {
      if (!options.desktop) throw new ApiError(400, "Only the desktop app installs the alden command.");
      return installCli();
    },

    async prepareNext() {
      const config = await loadConfig(options.cwd);
      if (!options.desktop || !config.background.enabled || config.background.prepare === 0) {
        return { prepared: null, reason: "off" };
      }
      const queue = (await api.queue({ refresh: false, repos: [], orgs: [] })) as RankedQueue;
      await dropStalePrepared(queue);
      const next = nextToPrepare(
        queue,
        (repo, number) => prepared.get(keyOf(repo, number))?.updatedAt,
        config.background.prepare,
      );
      if (!next) return { prepared: null, reason: "up to date" };
      const { pr } = next;
      const llm = await backgroundModelAllowed();
      const briefing = await runReview({ pr: `${pr.repo}#${pr.number}`, llm, graph: true }, () => {}, true);
      const entry = { briefing, updatedAt: pr.updatedAt, at: new Date().toISOString(), checkedAt: Date.now() };
      prepared.set(keyOf(pr.repo, pr.number), entry);
      return {
        prepared: {
          pr: `${pr.repo}#${pr.number}`,
          title: pr.title,
          places: briefing.needsYourEyes.length,
          model: briefing.llm?.status === "ok",
          at: entry.at,
        },
        // The desktop app's "Briefing ready" notification plays the system sound unless you turned it off.
        sound: config.notifications.sound,
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
      // Served only while it still matches the PR's head and base on GitHub (one request). Offline, the last queue's
      // update time is the best there is.
      const last = await cache.get<LastQueue>(LAST_QUEUE_KEY, 24 * 3_600_000);
      const fresh = await freshNow(entry.briefing.target).catch(() => undefined);
      const row = last?.rows?.find((r) => keyOf(r.repo, r.number) === pr.toLowerCase());
      const stale = fresh ? fresh.state !== "fresh" : row?.updatedAt !== undefined && row.updatedAt !== entry.updatedAt;
      if (stale) {
        prepared.delete(pr.toLowerCase());
        return null;
      }
      if (fresh) entry.checkedAt = Date.now();
      // Reading it is using Alden on that repo, for `alden stats`, and opening that PR, for learning.
      const target = entry.briefing.target;
      if (target.kind === "pr") {
        await new UsageLog().markUsed(target.repo).catch(() => {});
        noteOpened(last?.rows, target.url, "ui");
        openedBriefing(entry.briefing, await loadConfig(options.cwd));
      }
      return { briefing: entry.briefing, at: entry.at };
    },

    async freshness(target) {
      const resolved = await signedIn();
      try {
        return await checkFreshness(createGitHubClient(resolved.token), target);
      } catch (error) {
        throw new ApiError(502, describeGitHubError(error, resolved.source));
      }
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
        if (
          (change.action === "exclude" || change.action === "include") &&
          !(await scopeNote(store, target, change.id, change.path, change.action))
        ) {
          throw new ApiError(
            404,
            change.action === "exclude"
              ? `No note called ${change.id} in ${target}.`
              : `That note isn't stopped under ${change.path}.`,
          );
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
      // Verdicts, then review signals (told apart by their `type`), all redacted.
      return [...(await feedback.redacted()), ...feedback.redactedSignals()];
    },

    async openLink(url) {
      if (!options.desktop)
        throw new ApiError(400, "Only the desktop app opens links this way; a browser opens them itself.");
      openInBrowser(url, "Couldn't open a browser.");
      return { opened: url };
    },

    async saveFeedback() {
      if (!options.desktop) throw new ApiError(400, "Only the desktop app saves the export; a browser downloads it.");
      const events = [...(await feedback.redacted()), ...feedback.redactedSignals()];
      const name = `alden-feedback-${new Date().toISOString().slice(0, 10)}.json`;
      const saved = await saveToDownloads(name, `${JSON.stringify(events, null, 2)}\n`, options.downloads);
      return { ...saved, events: events.length };
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

    async drafts(pr) {
      const ref = await prOf(pr);
      // Brought to the PR's current head when GitHub can be reached; as they were otherwise (signed out, offline).
      await followPr(ref).catch(() => undefined);
      const list = drafts.list(ref.name);
      return {
        drafts: list.map(publicDraft),
        // Alden's drafts you haven't kept won't be sent, so they don't count as a word on the place they're on.
        unaddressed: unaddressedPlaces(
          drafts.briefed(ref.name)?.places ?? [],
          list.filter((d) => d.source !== "alden"),
        ),
      };
    },

    async addDraft(input: DraftInput, source: ReviewDraft["source"] = "you") {
      const ref = await prOf(input.pr);
      if (input.inReplyTo !== undefined) return addReply(ref, input, input.inReplyTo, source);
      const { headSha, files, client } = await followPr(ref);
      let spot: { place: Placement } | { linkTo: DraftLink } | undefined;
      if (input.path !== undefined || input.line !== undefined) {
        if (input.path === undefined) throw new ApiError(400, "A comment on a line needs the file too.");
        spot = await spotFor(client, ref, headSha, files, { ...input, path: input.path });
      } else if (input.startLine !== undefined) {
        throw new ApiError(400, "A multi-line comment needs the file and its last line too.");
      }
      try {
        const draft = drafts.add({
          pr: ref.name,
          headSha,
          body: input.body,
          source,
          ...spot,
          ...(input.suggestion !== undefined ? { suggestion: input.suggestion } : {}),
        });
        void track("draft_changed", { action: "add", source, inline: inline(draft) });
        if (input.assisted) {
          void track("draft_assisted", { reply: false, inline: inline(draft), edited: input.assisted.edited });
        }
        return publicDraft(draft);
      } catch (error) {
        throw new ApiError(400, (error as Error).message);
      }
    },

    async editDraft(id, change) {
      const draft = drafts.get(id);
      if (!draft) throw new ApiError(404, `No draft ${id}. It may have been sent or deleted.`);
      if (draft.inReplyTo !== undefined) return editReply(draft, change);
      if (change.resolve !== undefined) throw new ApiError(400, "Only a reply in a thread resolves it.");
      let place: (Placement & { headSha: string }) | undefined;
      let linkTo: (DraftLink & { headSha: string }) | undefined;
      if (change.path !== undefined || change.line !== undefined) {
        if (change.path === undefined) throw new ApiError(400, "Placing a comment on a line needs the file too.");
        const ref = await prOf(draft.pr);
        const { headSha, files, client } = await followPr(ref);
        const spot = await spotFor(client, ref, headSha, files, { ...change, path: change.path });
        if ("place" in spot) place = { ...spot.place, headSha };
        else linkTo = { ...spot.linkTo, headSha };
      } else if (change.startLine !== undefined) {
        throw new ApiError(400, "Placing a comment on lines needs the file and its last line too.");
      }
      let edited: ReturnType<ReviewDrafts["edit"]>;
      try {
        edited = drafts.edit(id, {
          ...(change.body !== undefined ? { body: change.body } : {}),
          ...(change.suggestion !== undefined ? { suggestion: change.suggestion } : {}),
          ...(place ? { place } : {}),
          ...(linkTo ? { linkTo } : {}),
        });
      } catch (error) {
        throw new ApiError(400, (error as Error).message);
      }
      if (!edited) throw new ApiError(404, `No draft ${id}. It may have been sent or deleted.`);
      void track("draft_changed", { action: "edit", source: edited.source, inline: inline(edited) });
      if (change.assisted) {
        void track("draft_assisted", { reply: false, inline: inline(edited), edited: change.assisted.edited });
      }
      // Editing one of Alden's drafts makes it yours, as keeping it does.
      if (edited.source === "alden" && (change.body !== undefined || change.suggestion !== undefined)) {
        const learn = (await loadConfig(options.cwd)).learning.fromReviews;
        const { kept } = await keepAldenDrafts({ ids: [id] }, { learn });
        return publicDraft(kept[0] ?? edited);
      }
      return publicDraft(edited);
    },

    async deleteDraft(id) {
      // Dropping one of Alden's drafts teaches a little (see `dropAldenDrafts`); anything else is just deleted.
      if (drafts.get(id)?.source === "alden") {
        const learn = (await loadConfig(options.cwd)).learning.fromReviews;
        const [dropped] = (await dropAldenDrafts([id], { learn })).dropped;
        if (dropped) {
          void track("draft_changed", { action: "discard", source: "alden", inline: inline(dropped) });
          return { ok: true };
        }
      }
      const deleted = drafts.delete(id);
      if (!deleted) throw new ApiError(404, `No draft ${id}. It may have been sent or deleted.`);
      void track("draft_changed", { action: "discard", source: deleted.source, inline: inline(deleted) });
      return { ok: true };
    },

    async keepDrafts({ ids, pr }) {
      const which = { ...(ids ? { ids } : {}), ...(pr ? { pr: (await prOf(pr)).name } : {}) };
      const learn = (await loadConfig(options.cwd)).learning.fromReviews;
      const { kept } = await keepAldenDrafts(which, { learn });
      for (const draft of kept) void track("draft_changed", { action: "keep", source: "alden", inline: inline(draft) });
      return { kept: kept.map(publicDraft) };
    },

    async draftReview({ pr }) {
      const ref = await prOf(pr);
      const config = await loadConfig(options.cwd);
      const choice = await selectProvider(config);
      if (!choice.ok) throw new ApiError(409, choice.reason);
      const briefing = await briefingForDrafting(ref.name);
      if (!briefing) {
        throw new ApiError(409, `Brief ${ref.name} first: Alden drafts from the briefing's places to look.`);
      }
      const { headSha, files, client } = await followPr(ref);
      if (briefing.target.kind !== "pr" || briefing.target.headSha !== headSha) {
        throw new ApiError(409, `${ref.name} has new commits since its briefing: brief it again, then draft.`);
      }
      // Where you've already commented on GitHub counts as a word on a place, as a draft does.
      const sent = await threadsOf(ref).then(
        (read) => sentComments(read.threads),
        () => [],
      );
      const detail = await fetchPullRequest(client, ref.repo, ref.number).catch(() => undefined);
      try {
        const result = await draftReview({
          briefing,
          files,
          headSha,
          description: detail?.body,
          learning: await learningFor(ref.repo),
          sent,
          provider: choice.provider,
          config,
          ledger: new SpendLedger(),
          checkLink: (link) => checkLinkTarget(client, ref.repo, headSha, link),
        });
        for (const d of result.made) void track("draft_changed", { action: "add", source: "alden", inline: inline(d) });
        if (result.asked) modelUsed(ref.name);
        return {
          made: result.made.length,
          skipped: result.skipped,
          asked: result.asked,
          costUsd: result.usd ?? null,
          drafts: result.made.map(publicDraft),
        };
      } catch (error) {
        throw draftingProblem(error);
      }
    },

    async suggestText(input, signal) {
      const ref = await prOf(input.pr);
      const config = await loadConfig(options.cwd);
      const choice = await selectProvider(config);
      if (!choice.ok) throw new ApiError(409, choice.reason);
      const { headSha, files, client, source } = await followPr(ref);
      let thread: ReviewThreads["threads"][number] | undefined;
      if (input.threadId !== undefined) {
        thread = (await threadsOf(ref)).threads.find((t) => t.id === input.threadId);
        if (!thread) throw new ApiError(404, "That thread isn't on the PR any more. Read the conversation again.");
      }
      let detail: Awaited<ReturnType<typeof fetchPullRequest>>;
      try {
        detail = await fetchPullRequest(client, ref.repo, ref.number);
      } catch (error) {
        throw new ApiError(502, describeGitHubError(error, source));
      }
      // The briefing you're looking at, when it's of this head: what Alden flagged near the line.
      const saved = await briefingForDrafting(ref.name);
      const briefing = saved?.target.kind === "pr" && saved.target.headSha === headSha ? saved : undefined;
      const at =
        input.path !== undefined
          ? { path: input.path, line: input.line, startLine: input.startLine, side: input.side }
          : undefined;
      try {
        const result = await suggestCommentText({
          target: {
            kind: "pr",
            repo: ref.repo,
            number: ref.number,
            url: detail.url,
            title: detail.title,
            author: detail.author?.login ?? null,
            baseRef: detail.baseRefName,
            headRef: detail.headRefName,
            headSha,
          },
          description: detail.body,
          files,
          learning: await learningFor(ref.repo),
          briefing,
          for: { ...(thread ? { thread } : at ? { at } : {}), ...(input.text?.trim() ? { text: input.text } : {}) },
          provider: choice.provider,
          config,
          ledger: new SpendLedger(),
          ...(signal ? { signal } : {}),
        });
        modelUsed(ref.name);
        return { text: result.text, costUsd: result.usd ?? null };
      } catch (error) {
        throw draftingProblem(error);
      }
    },

    async sendReview({ pr, event, body }) {
      const ref = await prOf(pr);
      const resolved = await signedIn();
      try {
        const config = await loadConfig(options.cwd);
        const sent = await sendReview(
          createGitHubClient(resolved.token),
          openStore(),
          { repo: ref.repo, number: ref.number, event, ...(body !== undefined ? { body } : {}) },
          new Date(),
          // What you saw in guided review and the Diff tab, so approving past a place you saw counts as a silent pass.
          {
            fromReviews: config.learning.fromReviews,
            seen: seenPlaces,
            reviewTime: config.stats.reviewTime,
          },
        );
        const { counts } = sent;
        // How long it took, in coarse buckets (stats.reviewTime on, and a session from opening its briefing).
        if (sent.timing) void track("review_timed", reviewTimedEvent(sent.timing));
        void track("review_sent", {
          review: event === "APPROVE" ? "approve" : event === "REQUEST_CHANGES" ? "request_changes" : "comment",
          inline: counts.inline,
          notes: counts.notes,
          from_you: counts.fromYou,
          from_claude: counts.fromClaude,
          has_body: counts.hasBody,
          unaddressed: counts.unaddressed,
        });
        if (Object.values(counts.signals).some((n) => n > 0)) {
          void track("review_signals", { source: "review", ...counts.signals });
        }
        // The threads changed: your replies, and what you resolved.
        threadsRead.delete(ref.name.toLowerCase());
        return {
          url: sent.url,
          posted: sent.posted,
          review: sent.review,
          ...(sent.replies !== undefined ? { replies: sent.replies } : {}),
          ...(sent.resolved !== undefined ? { resolved: sent.resolved } : {}),
          ...(sent.notResolved ? { notResolved: sent.notResolved } : {}),
          ...(sent.learning ? { learning: sent.learning } : {}),
        };
      } catch (error) {
        if (error instanceof SendReviewError) {
          const fix = error.reason === "forbidden" ? ` ${reviewWriteFix(resolved.source)}` : "";
          throw new ApiError(error.status, `${error.message}${fix}`);
        }
        throw new ApiError(502, describeGitHubError(error, resolved.source));
      }
    },

    async threads(pr, refresh = false) {
      return threadsOf(await prOf(pr), refresh);
    },

    async diff(pr, since) {
      if (pr === undefined) {
        try {
          return await localDiffView(options.cwd);
        } catch (error) {
          throw new ApiError(400, (error as Error).message);
        }
      }
      const ref = await prOf(pr);
      const resolved = await signedIn();
      try {
        return await pullRequestDiffView(createGitHubClient(resolved.token), ref.repo, ref.number, diffs, since);
      } catch (error) {
        throw new ApiError(502, describeGitHubError(error, resolved.source));
      }
    },

    async reportActive({ pr, activeMs }) {
      if (!(await loadConfig(options.cwd)).stats.reviewTime) return { counted: false };
      return { counted: addActiveTime(openStore(), pr, activeMs) };
    },

    async reviewTime() {
      const config = await loadConfig(options.cwd);
      return reviewTimeStats(openStore(), { enabled: config.stats.reviewTime });
    },

    async recordSeen({ pr, headSha, places }) {
      // Only ever on this machine, and not at all while you've turned learning from reviews off.
      if (!(await loadConfig(options.cwd)).learning.fromReviews) return { recorded: 0 };
      const store = openStore();
      const recorded = store.transaction(
        () => places.filter((place) => recordSeen(store, { pr, headSha, ...place })).length,
      );
      return { recorded };
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

  /**
   * A reply in a review thread, sent with the review: on a thread that's on the PR, where GitHub lets you reply (and
   * resolve, when ticked). No place of its own, so no diff to read.
   */
  async function addReply(
    ref: { repo: string; number: number; name: string },
    input: DraftInput,
    threadId: string,
    source: ReviewDraft["source"],
  ): Promise<ReviewDraft> {
    if (
      input.path !== undefined ||
      input.line !== undefined ||
      input.startLine !== undefined ||
      input.side !== undefined ||
      input.suggestion !== undefined
    ) {
      throw new ApiError(400, "A reply posts in its thread: leave out path, line, side and suggestion.");
    }
    const resolve = input.resolve === true;
    const threads = await checkReplyThread(ref, threadId, { reply: input.body.trim() !== "", resolve });
    try {
      const draft = drafts.addReply({
        pr: ref.name,
        headSha: threads.headSha,
        threadId,
        body: input.body,
        resolve,
        source,
      });
      void track("draft_changed", { action: "add", source, inline: false });
      if (input.assisted) void track("draft_assisted", { reply: true, inline: false, edited: input.assisted.edited });
      return publicDraft(draft);
    } catch (error) {
      throw new ApiError(400, (error as Error).message);
    }
  }

  /** A reply's text, or whether it resolves its thread; checked against the thread when it asks for more. */
  async function editReply(
    draft: ReturnType<ReviewDrafts["get"]> & {},
    change: Parameters<UiApi["editDraft"]>[1],
  ): Promise<ReviewDraft> {
    if (
      change.path !== undefined ||
      change.line !== undefined ||
      change.startLine !== undefined ||
      change.suggestion !== undefined
    ) {
      throw new ApiError(400, "A reply posts in its thread: it can't go on a line or carry a suggestion.");
    }
    const body = change.body ?? draft.body;
    const resolve = change.resolve ?? draft.resolve === true;
    const more = (body.trim() !== "" && draft.body.trim() === "") || (resolve && draft.resolve !== true);
    if (more) {
      await checkReplyThread(await prOf(draft.pr), draft.inReplyTo as string, { reply: body.trim() !== "", resolve });
    }
    let edited: ReturnType<ReviewDrafts["editReply"]>;
    try {
      edited = drafts.editReply(draft.id, {
        ...(change.body !== undefined ? { body: change.body } : {}),
        ...(change.resolve !== undefined ? { resolve: change.resolve } : {}),
      });
    } catch (error) {
      throw new ApiError(400, (error as Error).message);
    }
    if (!edited) throw new ApiError(404, `No draft ${draft.id}. It may have been sent or deleted.`);
    void track("draft_changed", { action: "edit", source: edited.source, inline: false });
    if (change.assisted) void track("draft_assisted", { reply: true, inline: false, edited: change.assisted.edited });
    return publicDraft(edited);
  }

  /** A PR briefing you opened: starts or continues its review session (stats.reviewTime). Never stops the review. */
  function openedBriefing(briefing: Briefing, config: AldenConfig): void {
    if (briefing.target.kind !== "pr" || !config.stats.reviewTime) return;
    try {
      openReviewSession(openStore(), {
        pr: prName(briefing.target.repo, briefing.target.number),
        surface: telemetrySurface(),
        model: briefing.llm?.status === "ok",
      });
    } catch {
      // only the timing is lost
    }
  }

  /** Alden's model drafted on a PR ("Draft my review", "Draft with Alden"): its review session used the model. */
  function modelUsed(pr: string): void {
    try {
      noteModelUsed(openStore(), pr);
    } catch {
      // only the timing is lost
    }
  }

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
      const choice = await selectProvider(config, request.model);
      if (choice.ok) model = { provider: choice.provider, ledger: new SpendLedger(), ...(effort ? { effort } : {}) };
      else unavailable = choice.reason;
    }
    const graph = { enabled: request.graph !== false, cwd: options.cwd, onStage };

    let briefing: Briefing;
    let diff: DiffFile[] | undefined;
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
          onDiff: (files) => {
            diff = files;
          },
        });
      } catch (error) {
        throw new ApiError(502, describeGitHubError(error, resolved.source));
      }
      if (!background && briefing.target.kind === "pr") noteOpened(last?.rows, briefing.target.url, "ui");
    }
    // Its places to look, for "you didn't comment on…" before a review is sent, and learning from comments.
    try {
      drafts.rememberBriefing(briefing);
    } catch {
      // the database is locked or damaged: the review still stands
    }
    // Opening it starts (or continues) the PR's review session, for time to review: before Alden's drafts, so they
    // count. A background briefing isn't you opening it: that's when you read it (see `prepared`).
    if (!background) openedBriefing(briefing, config);
    // What "Draft my review" and "Draft with Alden" draft from.
    await rememberForDrafting(briefing);
    // Comments drafted from the model's findings, for you to keep, edit or drop: never sent on their own. Not beside
    // a review thread already on the PR; drafted as before when the threads can't be read.
    try {
      const { target } = briefing;
      const threads =
        target.kind === "pr" && config.drafts.auto && briefing.llm?.status === "ok"
          ? (await threadsOf({ ...target, name: prName(target.repo, target.number) }).catch(() => undefined))?.threads
          : undefined;
      const { made } = makeAldenDrafts(briefing, diff, {
        enabled: config.drafts.auto,
        ...(threads ? { threads } : {}),
      });
      for (const draft of made) void track("draft_changed", { action: "add", source: "alden", inline: inline(draft) });
    } catch {
      // the review stands without drafts
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
