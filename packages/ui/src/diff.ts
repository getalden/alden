import type { PrDiff, PrDiffFile, PrDiffLine } from "@alden/schema";

/*
 * The Diff tab's logic, apart from React: which side and line a diff line is, what a pick or a drag means as a
 * comment's place, where places and drafts sit, and a cache so reopening a diff is instant.
 */

export type DiffSide = "RIGHT" | "LEFT";

/** Where a comment goes, as the comments drawer takes it: a line, or `startLine` to `line` on one side. */
export interface CommentPlace {
  path: string;
  line: number;
  side: DiffSide;
  startLine?: number;
}

/** A draft as the Diff tab marks it at its line. */
export interface DiffDraft {
  path?: string | undefined;
  line?: number | undefined;
  startLine?: number | undefined;
  side?: string | undefined;
  body: string;
  source: string;
  state: string;
}

/** One of Alden's places to look, numbered as the briefing numbers them (`index` 1 shows as E1). */
export interface DiffPlace {
  path: string;
  line?: number | undefined;
  title: string;
  index: number;
  /** The check that flagged it, for what you saw; absent for the model's own places. */
  checkId?: string | undefined;
  /** How much it matters, shown on its card under the line. */
  severity?: string | undefined;
  /** Why it's a place to look, shown on its card under the line. */
  reason?: string | undefined;
}

/** A line of the diff by position: file, hunk and line within the hunk. */
export interface LineRef {
  file: number;
  hunk: number;
  row: number;
}

/**
 * The side and line number GitHub uses for a diff line: removed lines are on the LEFT (the old file's numbers);
 * added and unchanged ones on the RIGHT (the new file's).
 */
export function sideOf(line: PrDiffLine): { side: DiffSide; line: number } | undefined {
  if (line.kind === "del") return line.oldLine === undefined ? undefined : { side: "LEFT", line: line.oldLine };
  return line.newLine === undefined ? undefined : { side: "RIGHT", line: line.newLine };
}

export const rowKey = (ref: LineRef) => `${ref.file}:${ref.hunk}:${ref.row}`;

/**
 * What picking `to` means, given the line picked before (`from`, for shift-click or the start of a drag): a range
 * when both are on the same side of the same hunk of the same file, otherwise just `to`.
 */
export function commentPlace(diff: PrDiff, to: LineRef, from?: LineRef): CommentPlace | undefined {
  const file = diff.files[to.file];
  const end = file?.hunks[to.hunk]?.lines[to.row];
  const endAt = end && sideOf(end);
  if (!file || !endAt) return undefined;
  const single: CommentPlace = { path: file.path, line: endAt.line, side: endAt.side };
  if (!from || from.file !== to.file || from.hunk !== to.hunk || from.row === to.row) return single;
  const start = file.hunks[from.hunk]?.lines[from.row];
  const startAt = start && sideOf(start);
  if (!startAt || startAt.side !== endAt.side) return single;
  return {
    ...single,
    line: Math.max(startAt.line, endAt.line),
    startLine: Math.min(startAt.line, endAt.line),
  };
}

/** Rows between two picks (inclusive) on the same side and hunk, for highlighting a range as it's dragged. */
export function rangeRows(diff: PrDiff, a: LineRef, b: LineRef): Set<string> {
  const place = commentPlace(diff, b, a);
  if (!place) return new Set();
  if (place.startLine === undefined) return new Set([rowKey(b)]);
  const lines = diff.files[b.file]?.hunks[b.hunk]?.lines ?? [];
  const keys = new Set<string>();
  lines.forEach((line, row) => {
    const at = sideOf(line);
    if (at && at.side === place.side && at.line >= (place.startLine ?? 0) && at.line <= place.line) {
      keys.add(rowKey({ file: b.file, hunk: b.hunk, row }));
    }
  });
  return keys;
}

/**
 * Finds the row showing `line` of `path`: on the new side first (where places and most comments are), then the old
 * side (a removed file has only that). `side` LEFT or RIGHT looks on that side only. Indexes the diff once.
 */
export function rowFinder(diff: PrDiff): (path: string, line: number, side?: string) => LineRef | undefined {
  const index = new Map<string, LineRef>();
  diff.files.forEach((f, file) => {
    f.hunks.forEach((h, hunk) => {
      h.lines.forEach((l, row) => {
        const at = sideOf(l);
        const key = at && `${at.side}\u0000${f.path}\u0000${at.line}`;
        if (key && !index.has(key)) index.set(key, { file, hunk, row });
      });
    });
  });
  return (path, line, side) => {
    const sides: DiffSide[] = side === "LEFT" ? ["LEFT"] : side === "RIGHT" ? ["RIGHT"] : ["RIGHT", "LEFT"];
    for (const want of sides) {
      const found = index.get(`${want}\u0000${path}\u0000${line}`);
      if (found) return found;
    }
    return undefined;
  };
}

/**
 * Whether GitHub takes an inline comment on these lines: in the PR's diff, on that side, a range within one hunk (as
 * the server's placeOnDiff decides). When it doesn't, a comment there is saved as a note in the review body that
 * links to the code. A whole file (no `line`) never does.
 */
export function takesInline(
  diff: PrDiff,
  place: { path: string; line?: number | undefined; startLine?: number | undefined; side?: string | undefined },
): boolean {
  const file = diff.files.find((f) => f.path === place.path);
  if (!file || file.binary || file.patchMissing || place.line === undefined) return false;
  const left = place.side === "LEFT";
  const hunkOf = (line: number) =>
    file.hunks.findIndex((h) =>
      h.lines.some((l) => (left ? l.kind !== "add" && l.oldLine === line : l.kind !== "del" && l.newLine === line)),
    );
  const last = hunkOf(place.line);
  if (last === -1) return false;
  if (place.startLine === undefined || place.startLine >= place.line) return true;
  return hunkOf(place.startLine) === last;
}

export const findRow = (diff: PrDiff, path: string, line: number, side?: string) => rowFinder(diff)(path, line, side);

/** Added and removed lines: from the server's counts, or counted (a patch's lines when the counts are absent). */
export function fileCounts(file: PrDiffFile): { additions: number; deletions: number } {
  if (file.additions !== undefined && file.deletions !== undefined) {
    return { additions: file.additions, deletions: file.deletions };
  }
  let additions = 0;
  let deletions = 0;
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.kind === "add") additions++;
      else if (l.kind === "del") deletions++;
    }
  }
  return { additions, deletions };
}

export const lineCount = (file: PrDiffFile) => file.hunks.reduce((n, h) => n + h.lines.length, 0);

/** Places and drafts by the row they sit on, plus those that have no row (a whole file, or a line outside the diff). */
export interface Markers {
  rows: Map<string, { places: DiffPlace[]; drafts: DiffDraft[] }>;
  /** By file index: places and drafts on the file but not on a line shown. */
  files: Map<number, { places: DiffPlace[]; drafts: DiffDraft[] }>;
}

export function placeMarkers(diff: PrDiff, places: DiffPlace[] = [], drafts: DiffDraft[] = []): Markers {
  const rows: Markers["rows"] = new Map();
  const files: Markers["files"] = new Map();
  const at = <K>(map: Map<K, { places: DiffPlace[]; drafts: DiffDraft[] }>, key: K) => {
    const entry = map.get(key) ?? { places: [], drafts: [] };
    map.set(key, entry);
    return entry;
  };
  const find = rowFinder(diff);
  const put = (
    path: string,
    line: number | undefined,
    side: string | undefined,
    add: (e: { places: DiffPlace[]; drafts: DiffDraft[] }) => void,
  ) => {
    const ref = line !== undefined ? find(path, line, side) : undefined;
    if (ref) add(at(rows, rowKey(ref)));
    else {
      const file = diff.files.findIndex((f) => f.path === path);
      if (file !== -1) add(at(files, file));
    }
  };
  for (const place of places) put(place.path, place.line, undefined, (e) => e.places.push(place));
  for (const draft of drafts) {
    if (draft.path) put(draft.path, draft.line, draft.side ?? "RIGHT", (e) => e.drafts.push(draft));
  }
  return { rows, files };
}

/** Places in the order they appear in the diff, for ] and [: by file, then down the file. Unplaceable ones last. */
export function placeOrder(
  diff: PrDiff,
  places: DiffPlace[] = [],
): { place: DiffPlace; ref?: LineRef; file: number }[] {
  const find = rowFinder(diff);
  return places
    .map((place) => {
      const file = diff.files.findIndex((f) => f.path === place.path);
      const ref = place.line !== undefined ? find(place.path, place.line) : undefined;
      return { place, file, ...(ref ? { ref } : {}) };
    })
    .filter((p) => p.file !== -1)
    .sort(
      (a, b) =>
        a.file - b.file ||
        (a.ref ? a.ref.hunk : -1) - (b.ref ? b.ref.hunk : -1) ||
        (a.ref ? a.ref.row : -1) - (b.ref ? b.ref.row : -1) ||
        a.place.index - b.place.index,
    );
}

/**
 * Diffs fetched this session, by PR and the head commit its briefing was of, so switching back to the Diff tab, or
 * opening the PR again, shows it at once. Local changes aren't kept: the working tree changes without a commit.
 */
const cache = new Map<string, Promise<PrDiff>>();
const CACHE_LIMIT = 12;

export function cachedDiff(
  load: (pr?: string, since?: string) => Promise<PrDiff>,
  pr?: string,
  headSha?: string,
  since?: string,
): Promise<PrDiff> {
  if (!pr || !headSha) return since ? load(pr, since) : load(pr);
  // The changes since your review are kept apart from the whole PR.
  const key = `${pr.toLowerCase()}@${headSha}${since ? `~${since}` : ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const loading = since ? load(pr, since) : load(pr);
  cache.set(key, loading);
  // A failed load isn't kept, so trying again asks again.
  loading.catch(() => cache.delete(key));
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return loading;
}

export function clearDiffCache(): void {
  cache.clear();
}
