import {
  createGitHubClient,
  fetchReviewQueue,
  JsonCache,
  loadConfig,
  openStore,
  queueEvent,
  queueRows,
  queueScope,
  rankQueue,
  resolveToken,
  SpendLedger,
  selectProvider,
  track,
} from "@alden/core";
import type {
  Briefing,
  FeedbackInput,
  RankedQueue,
  ReviewDraft,
  ReviewEvent,
  ReviewThread,
  SendReviewResult,
  UnaddressedPlace,
} from "@alden/schema";
import { LAST_QUEUE_KEY, type LastQueue, openInBrowser } from "../commands/open.js";
import { describeGitHubError } from "../github-errors.js";
import { learningForQueue, noteOpened } from "../learning.js";
import { checkSentOutcomes } from "../outcomes.js";
import { createUiApi } from "../ui/api.js";
import type { DraftInput } from "../ui/server.js";

/** The model `m` would run, and what it may cost, or why there's none. */
export type ModelChoice =
  | { available: true; model: string; perReviewUsd: number; dailyUsd: number; spentToday: number }
  | { available: false; reason: string };

/** What `alden send` would send for a PR: your drafts (not Alden's you haven't kept), and what it warns about. */
export interface PendingReview {
  drafts: ReviewDraft[];
  unaddressed: UnaddressedPlace[];
  threads: ReviewThread[];
  /** Alden's drafts you haven't kept, which stay behind. */
  unkept: number;
}

/**
 * Everything the interactive view asks of Alden. The real one makes the same calls the commands make; tests give a
 * fake, so no GitHub, model or keychain is touched.
 */
export interface Engine {
  /** The ranked queue, as `alden queue` fetches it, saying what it's doing as it goes. */
  queue(refresh: boolean, onProgress: (label: string) => void): Promise<RankedQueue>;
  /** A PR's briefing, as `alden review` makes it (with the model when `llm`). */
  brief(pr: string, llm: boolean, onProgress: (label: string) => void): Promise<Briefing>;
  model(): Promise<ModelChoice>;
  /** Records a verdict on a place, as `alden ui` does; `progress` says how close a lesson is. */
  feedback(input: FeedbackInput): Promise<{ progress?: string }>;
  /** A draft comment, as `alden comment` writes one. */
  comment(input: DraftInput): Promise<ReviewDraft>;
  pending(pr: string): Promise<PendingReview>;
  /** Sends the PR's drafts as one review: the only call that writes to GitHub. */
  send(pr: string, event: ReviewEvent): Promise<SendReviewResult>;
  /** Opens a PR on GitHub in the browser. */
  open(url: string): void;
}

/** The PRs `alden queue` fetches by default. */
const QUEUE_LIMIT = 100;

export function createEngine(options: { version: string; cwd: string }): Engine {
  const api = createUiApi(options);
  const cache = new JsonCache();
  let lastRows: LastQueue["rows"];

  return {
    async queue(refresh, onProgress) {
      const resolved = await resolveToken();
      if (!resolved) throw new Error("Not signed in. Run `alden auth login`.");
      const config = await loadConfig();
      const client = createGitHubClient(resolved.token);
      let queue: Awaited<ReturnType<typeof fetchReviewQueue>>;
      try {
        queue = await fetchReviewQueue(client, {
          includeDrafts: config.queue.includeDrafts,
          limit: QUEUE_LIMIT,
          cache,
          refresh,
          ...queueScope(config),
          onProgress: (step) => onProgress(`${step}…`),
        });
      } catch (error) {
        throw new Error(describeGitHubError(error, resolved.source));
      }
      void Promise.resolve()
        .then(() => checkSentOutcomes(client, openStore()))
        .catch(() => {});
      onProgress("Seeing what needs your eyes…");
      const ranked = rankQueue(queue, config.queue, Date.now(), await learningForQueue(queue));
      await track("queue_ranked", queueEvent(ranked));
      // So `alden review 3` and `alden open 3` mean the rows shown here, as after `alden queue`.
      const last: LastQueue = {
        urls: [...ranked.needsYou, ...ranked.fastTrack].map((r) => r.pr.url),
        rows: queueRows(ranked, config.queue),
      };
      lastRows = last.rows;
      await cache.set(LAST_QUEUE_KEY, last);
      return ranked;
    },

    brief: (pr, llm, onProgress) => api.review({ pr, llm, graph: true }, (_stage, label) => onProgress(label)),

    async model() {
      const config = await loadConfig();
      const choice = await selectProvider(config);
      if (!choice.ok) return { available: false, reason: choice.reason };
      return {
        available: true,
        model: choice.provider.model,
        perReviewUsd: config.budget.perReviewUsd,
        dailyUsd: config.budget.dailyUsd,
        spentToday: await new SpendLedger().spentOn(),
      };
    },

    feedback: async (input) => (await api.addFeedback(input)) as { progress?: string },

    comment: (input) => api.addDraft(input),

    async pending(pr) {
      const listed = await api.drafts(pr);
      // As `alden send`: Alden's drafts you haven't kept stay behind, and replies say which thread they're in.
      const drafts = listed.drafts.filter((d) => d.source !== "alden");
      const threads = drafts.some((d) => d.inReplyTo !== undefined)
        ? ((await api.threads(pr).catch(() => undefined))?.threads ?? [])
        : [];
      return { drafts, unaddressed: listed.unaddressed, threads, unkept: listed.drafts.length - drafts.length };
    },

    send: (pr, event) => api.sendReview({ pr, event }),

    open(url) {
      // Only ever hand the OS a web link.
      if (!url.startsWith("https://")) return;
      openInBrowser(url, "");
      noteOpened(lastRows, url, "cli");
    },
  };
}
