import { type FollowUpEventKind, type FollowUpLevel, FollowUpLevelSchema, type PrWatch } from "@alden/schema";
import type { AldenStore } from "../store/db.js";

/**
 * Your notification level for one PR (`alden watch`, the bell in the UI), overriding `notifications.followUps` until
 * the PR is merged or closed: the follow-up check clears it then (see `checkFollowUps`). Kept in `pr_watch`, one row
 * per PR, on this machine only.
 */

/** "owner/repo#123" lowercased: how the database names a PR. */
export const prKeyOf = (repo: string, number: number) => `${repo}#${number}`.toLowerCase();

/** The kinds of follow-up each level lets through: a level lets through everything the one before it does. */
const ALLOWS: Record<FollowUpLevel, readonly FollowUpEventKind[]> = {
  off: [],
  rereview: ["rereview"],
  "your-turn": ["rereview", "your-turn"],
  "every-reply": ["rereview", "your-turn", "reply", "resolved", "outdated"],
};

/** Whether a PR at `level` notifies you of an event of `kind`. */
export const levelAllows = (level: FollowUpLevel, kind: FollowUpEventKind) => ALLOWS[level].includes(kind);

export interface WatchOverride {
  /** "owner/repo#123", as you typed the repo. */
  pr: string;
  repo: string;
  number: number;
  level: FollowUpLevel;
  setAt: string;
}

interface WatchRow {
  repo: string;
  number: number;
  level: string;
  set_at: string;
}

const fromRow = (row: WatchRow): WatchOverride | undefined => {
  const level = FollowUpLevelSchema.safeParse(row.level);
  if (!level.success) return undefined;
  return {
    pr: `${row.repo}#${Number(row.number)}`,
    repo: row.repo,
    number: Number(row.number),
    level: level.data,
    setAt: row.set_at,
  };
};

/** A PR's own level, or undefined when it follows the global setting. */
export function watchOverride(store: AldenStore, repo: string, number: number): WatchOverride | undefined {
  const row = store.get<WatchRow>("SELECT * FROM pr_watch WHERE pr_key = ?", prKeyOf(repo, number));
  return row ? fromRow(row) : undefined;
}

/** Sets a PR's own level, replacing any it had. */
export function setWatch(
  store: AldenStore,
  repo: string,
  number: number,
  level: FollowUpLevel,
  now: Date = new Date(),
): WatchOverride {
  const parsed = FollowUpLevelSchema.parse(level);
  store.run(
    "INSERT OR REPLACE INTO pr_watch (pr_key, repo, number, level, set_at) VALUES (?, ?, ?, ?, ?)",
    prKeyOf(repo, number),
    repo,
    number,
    parsed,
    now.toISOString(),
  );
  return { pr: `${repo}#${number}`, repo, number, level: parsed, setAt: now.toISOString() };
}

/** Puts a PR back on the global setting. True when it had its own level. */
export function clearWatch(store: AldenStore, repo: string, number: number): boolean {
  return store.run("DELETE FROM pr_watch WHERE pr_key = ?", prKeyOf(repo, number)).changes > 0;
}

/** Every PR with its own level, the most recently set first. */
export function listWatches(store: AldenStore): WatchOverride[] {
  return store
    .all<WatchRow>("SELECT * FROM pr_watch ORDER BY set_at DESC, pr_key")
    .flatMap((row) => fromRow(row) ?? []);
}

/** What applies to a PR: its own level if it has one, else `global` (`notifications.followUps`). */
export function prWatch(store: AldenStore, repo: string, number: number, global: FollowUpLevel): PrWatch {
  const override = watchOverride(store, repo, number)?.level;
  return { pr: `${repo}#${number}`, ...(override ? { override } : {}), level: override ?? global };
}
