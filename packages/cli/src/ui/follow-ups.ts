import {
  ackFollowUps,
  checkFollowUps,
  clearWatch,
  createGitHubClient,
  type FollowUpQueueRow,
  fillFollowUpCounts,
  followUpRows,
  followUpsWanted,
  loadConfig,
  markFollowUpsSeen,
  openStore,
  pendingFollowUps,
  prWatch,
  type ResolvedToken,
  refreshFollowUps,
  setWatch,
  withYourTurn,
} from "@alden/core";
import type { FollowUpLevel, FollowUpNotifications, PrWatch, RankedQueue } from "@alden/schema";
import { describeGitHubError } from "../github-errors.js";
import { ApiError } from "./server.js";

/** Follow-ups and watch levels, for the desktop app's notifications, Settings and the bell on a PR. */
export interface FollowUpsApi {
  /**
   * Checks the PRs you reviewed (only those GitHub says changed, at most once a minute), then answers what to tell you:
   * one notification per PR, at its level. Shown notifications are acknowledged with `ack`.
   */
  check(): Promise<FollowUpNotifications>;
  ack(ids: string[]): Promise<{ acked: number }>;
  /** A PR's level ("owner/repo#12", a URL or a queue number): its own, or the global one. */
  watch(pr: string): Promise<PrWatch>;
  /** Sets a PR's own level; `null` puts it back on the global one. */
  setWatch(pr: string, level: FollowUpLevel | null): Promise<PrWatch>;
  /**
   * With a fresh queue: the follow-up check, as the desktop app runs it (same limits, nothing asked of GitHub when no
   * PR could show news), waiting at most `FOLLOW_UP_WAIT_MS`. Never throws.
   */
  refresh(queue: RankedQueue): Promise<void>;
  /**
   * Every ranked queue the UI is served passes through here: its rows that you reviewed before get their thread counts
   * and unseen news from the last check, the other PRs with news make `yourTurn` (in `scope`), and their re-review
   * requests are kept for the next check.
   */
  noteQueue(queue: RankedQueue, scope?: { repos: string[]; orgs: string[]; ignore: string[] }): Promise<RankedQueue>;
  /** You opened a PR ("owner/repo#12", a URL or a queue number): what happened on it is seen, and leaves Your turn. */
  seen(pr: string): Promise<{ seen: number }>;
}

/** How long a queue waits for the follow-up check before it's served with what's stored. */
export const FOLLOW_UP_WAIT_MS = 8_000;

export interface FollowUpsApiOptions {
  cwd: string;
  /** The GitHub sign-in; throws (409) when there's none. */
  signedIn(): Promise<ResolvedToken>;
  /** A PR as typed, as the drafts routes read it. */
  prRef(pr: string): Promise<{ repo: string; number: number }>;
}

export function createFollowUpsApi(options: FollowUpsApiOptions): FollowUpsApi {
  /** The last queue's rows, for re-review requests: the desktop app reads the queue before it asks for follow-ups. */
  let queueRows: FollowUpQueueRow[] = [];
  const settings = async () => (await loadConfig(options.cwd)).notifications;

  return {
    async check() {
      const { followUps: global, sound } = await settings();
      const store = openStore();
      // Nothing could be told: don't ask GitHub.
      if (!followUpsWanted(store, global)) {
        return { notifications: pendingFollowUps(store, global), sound };
      }
      const resolved = await options.signedIn();
      try {
        await checkFollowUps(createGitHubClient(resolved.token), store, { global, queue: queueRows });
      } catch (error) {
        throw new ApiError(502, describeGitHubError(error, resolved.source));
      }
      return { notifications: pendingFollowUps(store, global), sound };
    },

    async ack(ids) {
      return { acked: ackFollowUps(openStore(), ids) };
    },

    async watch(pr) {
      const ref = await options.prRef(pr);
      return prWatch(openStore(), ref.repo, ref.number, (await settings()).followUps);
    },

    async setWatch(pr, level) {
      const ref = await options.prRef(pr);
      const store = openStore();
      if (level === null) clearWatch(store, ref.repo, ref.number);
      else setWatch(store, ref.repo, ref.number, level);
      return prWatch(store, ref.repo, ref.number, (await settings()).followUps);
    },

    async refresh(queue) {
      queueRows = followUpRows(queue);
      try {
        const [{ followUps: global }, resolved] = await Promise.all([settings(), options.signedIn()]);
        await refreshFollowUps(createGitHubClient(resolved.token), openStore(), {
          global,
          queue: queueRows,
          waitMs: FOLLOW_UP_WAIT_MS,
        });
      } catch {
        // Signed out, or the config doesn't load: the queue says so itself.
      }
    },

    async noteQueue(queue, scope) {
      queueRows = followUpRows(queue);
      try {
        const store = openStore();
        const { followUps: global } = await settings();
        return withYourTurn(store, fillFollowUpCounts(store, queue), { global, ...(scope ? { scope } : {}) });
      } catch {
        return queue; // the database is locked or damaged: the queue still stands
      }
    },

    async seen(pr) {
      const ref = await options.prRef(pr);
      return { seen: markFollowUpsSeen(openStore(), ref.repo, ref.number) };
    },
  };
}
