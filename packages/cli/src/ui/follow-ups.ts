import {
  ackFollowUps,
  checkFollowUps,
  clearWatch,
  createGitHubClient,
  type FollowUpQueueRow,
  fillFollowUpCounts,
  listWatches,
  loadConfig,
  openStore,
  pendingFollowUps,
  prWatch,
  type ResolvedToken,
  setWatch,
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
   * Every ranked queue the UI is served passes through here: its rows that you reviewed before get their thread counts
   * from the last check, and their re-review requests are kept for the next one.
   */
  noteQueue(queue: RankedQueue): RankedQueue;
}

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
      if (global === "off" && listWatches(store).every((w) => w.level === "off")) {
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

    noteQueue(queue) {
      const rows = [...queue.needsYou, ...queue.fastTrack];
      queueRows = rows.filter((r) => r.followUp).map((r) => ({ pr: r.pr, followUp: r.followUp }));
      try {
        return fillFollowUpCounts(openStore(), queue);
      } catch {
        return queue; // the database is locked or damaged: the queue still stands
      }
    },
  };
}
