import type { AldenStore } from "../store/db.js";

/**
 * The places Alden flagged that you actually saw: a guided review step shown for 1.5 s, or an E1, E2… marker in the
 * Diff tab on screen for 1.5 s. A review that approves without a word on a place you saw counts as a weak "probably
 * not worth your time"; a place you never saw counts as nothing. Kept on this machine only: never synced, exported or
 * sent with telemetry.
 */
export interface SeenPlace {
  /** The check that flagged it; absent for the model's own places. */
  checkId?: string;
  path: string;
  line?: number;
  /** Where you saw it: a guided review step, or its marker in the Diff tab. */
  how: "guided" | "diff";
}

/** How long a seen place is kept. */
export const SEEN_KEEP_DAYS = 90;
/** How many PRs' seen places are kept, the most recently seen first. */
export const SEEN_KEEP_PRS = 200;

const keyOf = (pr: string) => pr.trim().toLowerCase();
const placeKey = (place: { checkId?: string | undefined; path: string; line?: number | undefined }) =>
  `${place.checkId ?? ""}|${place.path}|${place.line ?? ""}`;

/**
 * Records that you saw a place in a PR ("owner/repo#12") at a head commit. Seeing the same place again at the same head
 * changes nothing (the first time, and how, are kept). Prunes what's older than 90 days, and beyond the last 200 PRs.
 */
export function recordSeen(
  store: AldenStore,
  input: { pr: string; headSha: string } & SeenPlace,
  now = new Date(),
): boolean {
  const { changes } = store.run(
    `INSERT OR IGNORE INTO seen_places (pr_key, head_sha, place_key, check_id, path, line, how, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    keyOf(input.pr),
    input.headSha,
    placeKey(input),
    input.checkId ?? null,
    input.path,
    input.line ?? null,
    input.how,
    now.toISOString(),
  );
  if (changes > 0) pruneSeen(store, now);
  return changes > 0;
}

function pruneSeen(store: AldenStore, now: Date): void {
  const cutoff = new Date(now.getTime() - SEEN_KEEP_DAYS * 86_400_000).toISOString();
  store.run("DELETE FROM seen_places WHERE seen_at < ?", cutoff);
  store.run(
    `DELETE FROM seen_places WHERE pr_key NOT IN (
       SELECT pr_key FROM seen_places GROUP BY pr_key ORDER BY MAX(seen_at) DESC LIMIT ?
     )`,
    SEEN_KEEP_PRS,
  );
}

/**
 * The places you saw in a PR ("owner/repo#12"), first seen first: at one head commit, or at any (each place once,
 * as you first saw it).
 */
export function seenPlaces(store: AldenStore, pr: string, headSha?: string): SeenPlace[] {
  const rows = store.all<{ check_id: string | null; path: string; line: number | null; how: string; key: string }>(
    `SELECT check_id, path, line, how, place_key AS key FROM seen_places
     WHERE pr_key = ?${headSha === undefined ? "" : " AND head_sha = ?"}
     ORDER BY seen_at, rowid`,
    ...(headSha === undefined ? [keyOf(pr)] : [keyOf(pr), headSha]),
  );
  const keys = new Set<string>();
  const out: SeenPlace[] = [];
  for (const row of rows) {
    if (keys.has(row.key)) continue;
    keys.add(row.key);
    out.push({
      ...(row.check_id !== null ? { checkId: row.check_id } : {}),
      path: row.path,
      ...(row.line !== null ? { line: Number(row.line) } : {}),
      how: row.how === "diff" ? "diff" : "guided",
    });
  }
  return out;
}
