import { randomUUID } from "node:crypto";
import {
  type Briefing,
  codeFence,
  type DraftLink,
  DraftLinkSchema,
  type LookHere,
  linkLines,
  noteText,
  type ReviewDraft,
  ReviewDraftSchema,
  type ReviewEvent,
  type ReviewSignalEvent,
  type ReviewSignalKind,
  type ReviewThread,
  type ReviewThreads,
  type SendReviewResult,
  type UnaddressedPlace,
} from "@alden/schema";
import type { DiffFile } from "../diff/parse.js";
import { fetchPullRequestDiff } from "../diff/sources.js";
import { signalCounts } from "../feedback/log.js";
import type { GitHubClient } from "../github/client.js";
import { rememberSentComments, type SentCommentInput } from "../github/outcomes.js";
import { fetchReviewThreads } from "../github/threads.js";
import { loadLearning, reviewProgress } from "../learn/learn.js";
import { closeReviewSession, dropReviewSession, noteDrafted, type ReviewTiming } from "../stats/review-time.js";
import type { AldenStore } from "../store/db.js";
import { type StoreSource, storeFrom } from "../store/source.js";
import { isNear } from "./near.js";
import { type BriefedPlace, briefedPlaces, confirmNotes, learnFromReview, type SeenReader } from "./signals.js";

export { isNear, NEAR_LINES } from "./near.js";

/**
 * Comments you write in Alden, kept as a pending review in the local database until you send them to GitHub as one
 * review. Nothing here posts on its own: `sendReview` is the only call that writes to GitHub, and only the CLI's
 * `alden send` and the UI's send button call it, after you've seen exactly what will post.
 */

export type Side = "RIGHT" | "LEFT";

/** A draft's line as it read when it was written, with its neighbours in the hunk: how it's found again later. */
export interface LineAnchor {
  text: string;
  before?: string;
  after?: string;
}

/**
 * Where an inline draft sits: a line on one side of a file's diff, or (with `startLine`) the lines from `startLine` to
 * `line`, all on that side and in one hunk, which is the only kind of range GitHub takes.
 */
export interface Placement {
  path: string;
  line: number;
  side: Side;
  /** The line's text and its neighbours; for a range, the last line's text and the lines just outside the range. */
  anchor: LineAnchor;
  /** A range's first line; absent for a single line. */
  startLine?: number;
  /** The commented lines' text, first to last: what a suggestion replaces. Absent on drafts from before 0.6. */
  lines?: string[];
}

/** GitHub's own limit on a comment's length. */
export const MAX_COMMENT_CHARS = 65_536;

export const prName = (repo: string, number: number) => `${repo}#${number}`;
const keyOf = (pr: string) => pr.toLowerCase();

// --- Lines in the diff ------------------------------------------------------------------------------------------

interface SideLine extends LineAnchor {
  line: number;
  /** Which hunk of the file it's in, from 0: a multi-line comment can't cross from one to another. */
  hunk: number;
}

/**
 * The lines GitHub takes comments on, on one side of a file's diff: added and unchanged lines on the right, removed
 * and unchanged lines on the left. Each carries its neighbours within the hunk. Within a hunk, one side's lines are
 * numbered without gaps.
 */
export function commentableLines(file: DiffFile, side: Side): SideLine[] {
  const out: SideLine[] = [];
  for (const [index, hunk] of file.hunks.entries()) {
    const lines = hunk.lines.filter((l) => (side === "RIGHT" ? l.kind !== "del" : l.kind !== "add"));
    lines.forEach((l, i) => {
      const line = side === "RIGHT" ? l.newLine : l.oldLine;
      if (line === undefined) return;
      const before = lines[i - 1]?.text;
      const after = lines[i + 1]?.text;
      out.push({
        line,
        hunk: index,
        text: l.text,
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
      });
    });
  }
  return out;
}

/** A run of lines' anchor: the last line's text, with the line before the first and the line after the last. */
const anchorOf = (first: SideLine, last: SideLine): LineAnchor => ({
  text: last.text,
  ...(first.before !== undefined ? { before: first.before } : {}),
  ...(last.after !== undefined ? { after: last.after } : {}),
});

/**
 * Places a comment on a line of the diff, or with `startLine` on the lines from there to `line`, or says (in a
 * sentence) why GitHub wouldn't take one there. A range must be on one side and within one hunk; a `startLine` equal
 * to `line` is just that line.
 */
export function placeOnDiff(
  files: DiffFile[],
  path: string,
  line: number,
  side: Side = "RIGHT",
  startLine?: number,
): Placement | { problem: string } {
  const file = files.find((f) => f.path === path);
  if (!file) return { problem: `${path} isn't changed in this PR, so GitHub won't take a comment on it.` };
  if (file.binary || file.patchMissing) {
    return {
      problem: `GitHub doesn't show ${path}'s diff (it's binary or too large), so there's no line to comment on. Write a general note instead.`,
    };
  }
  const lines = commentableLines(file, side);
  const where = side === "LEFT" ? " on the old side" : "";
  const found = lines.find((l) => l.line === line);
  if (startLine === undefined || startLine === line) {
    if (!found) {
      return {
        problem: `Line ${line} of ${path} isn't in this PR's diff${where}: GitHub only takes comments on changed lines and the few shown around them.`,
      };
    }
    return { path, line, side, anchor: anchorOf(found, found), lines: [found.text] };
  }
  if (startLine > line) {
    return { problem: `A range goes from its first line to its last, and ${startLine} comes after ${line}.` };
  }
  const first = lines.find((l) => l.line === startLine);
  if (!first || !found) {
    return {
      problem: `Line ${first ? line : startLine} of ${path} isn't in this PR's diff${where}: every line of a multi-line comment must be in one hunk of the diff (the changed lines and the few shown around them).`,
    };
  }
  if (first.hunk !== found.hunk) {
    return {
      problem: `Lines ${startLine}-${line} of ${path} span ${found.hunk - first.hunk + 1} hunks of this PR's diff${where}: GitHub only takes a multi-line comment within one hunk. Shorten the range, or write two comments.`,
    };
  }
  const range = lines.filter((l) => l.hunk === found.hunk && l.line >= startLine && l.line <= line);
  return { path, line, side, startLine, anchor: anchorOf(first, found), lines: range.map((l) => l.text) };
}

/**
 * Where a comment goes: inline on the diff when GitHub takes it there (see `placeOnDiff`), otherwise a linked note,
 * a general note in the review body with a link to the code at the PR's head. A whole file (no `line`) is always a
 * linked note. Only what can't be linked stays a problem: a range the wrong way round, or old-side (LEFT) lines
 * outside the diff, which aren't in the file at the head.
 */
export function placeOrLink(
  files: DiffFile[],
  path: string,
  line: number | undefined,
  side: Side = "RIGHT",
  startLine?: number,
): { place: Placement } | { linkTo: DraftLink } | { problem: string } {
  if (line === undefined) {
    if (startLine !== undefined) return { problem: "A range needs its last line too." };
    if (side === "LEFT") return { problem: "A link goes to the file as it is at the PR's head: leave out side LEFT." };
    return { linkTo: { path } };
  }
  if (startLine !== undefined && startLine > line) {
    return { problem: `A range goes from its first line to its last, and ${startLine} comes after ${line}.` };
  }
  const placed = placeOnDiff(files, path, line, side, startLine);
  if (!("problem" in placed)) return { place: placed };
  if (side === "LEFT") return placed;
  return { linkTo: { path, line, ...(startLine !== undefined && startLine < line ? { startLine } : {}) } };
}

/** "py/orders/tasks.py, line 5", "…, lines 5–9", or the path alone for a whole file: what a linked note links to. */
export const linkText = (link: DraftLink) => {
  const lines = linkLines(link);
  return lines ? `${link.path}, ${lines}` : link.path;
};

/**
 * Checks a linked note's code is there to link to: the file at `sha` in `repo`, with that many lines. Says why not
 * in a sentence; undefined when it's there, or when GitHub couldn't say (the link is then kept as written).
 */
export async function checkLinkTarget(
  client: GitHubClient,
  repo: string,
  sha: string,
  link: DraftLink,
): Promise<string | undefined> {
  const [owner, name] = repo.split("/") as [string, string];
  const short = sha.slice(0, 7);
  let data: unknown;
  try {
    ({ data } = await client.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo: name,
      path: link.path,
      ref: sha,
    }));
  } catch (error) {
    if ((error as { status?: number }).status === 404) {
      return `${link.path} isn't in ${repo} at the PR's head (${short}), so there's nothing to link to. Check the path.`;
    }
    return undefined;
  }
  if (Array.isArray(data) || (data as { type?: string }).type !== "file") {
    return `${link.path} is a folder at the PR's head (${short}), not a file: name a file to link to.`;
  }
  const { content, encoding } = data as { content?: string; encoding?: string };
  if (link.line === undefined || typeof content !== "string" || encoding !== "base64" || content === "") {
    return undefined;
  }
  const text = Buffer.from(content, "base64").toString("utf8");
  const count = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  if (link.line > count) {
    return `${link.path} has ${count} line${count === 1 ? "" : "s"} at the PR's head (${short}), so there's no line ${link.line} to link to.`;
  }
  return undefined;
}

/**
 * Finds a draft's line (or range of lines) again in a newer diff: the same text, every line of it, contiguous within
 * one hunk on the same side of the same file (or the file it was renamed to), preferring the candidate whose
 * neighbours still match, then the one nearest the old place. Undefined when any of the lines changed, left the diff,
 * or can't be told apart from others like them: an `outdated` draft, which you place again rather than have Alden
 * guess. A suggestion is only ever moved onto exactly the code it was written against.
 */
export function findAgain(placement: Placement, files: DiffFile[]): Placement | undefined {
  const file = files.find((f) => f.path === placement.path) ?? files.find((f) => f.previousPath === placement.path);
  if (!file) return undefined;
  const { anchor } = placement;
  const original = placement.lines ?? [anchor.text];
  if (original.length === 0 || original[original.length - 1] !== anchor.text) return undefined;
  const lines = commentableLines(file, placement.side);
  const candidates: { first: SideLine; last: SideLine }[] = [];
  for (let i = 0; i + original.length <= lines.length; i++) {
    const run = lines.slice(i, i + original.length);
    const first = run[0] as SideLine;
    if (run.every((l, k) => l.text === original[k] && l.hunk === first.hunk)) {
      candidates.push({ first, last: run[run.length - 1] as SideLine });
    }
  }
  if (candidates.length === 0) return undefined;
  const score = ({ first, last }: { first: SideLine; last: SideLine }) =>
    (anchor.before !== undefined && first.before === anchor.before ? 1 : 0) +
    (anchor.after !== undefined && last.after === anchor.after ? 1 : 0);
  const best = Math.max(...candidates.map(score));
  // Blank lines or lone braces are only themselves when something around them agrees.
  if (original.every((text) => text.trim().length < 3) && best === 0) return undefined;
  const top = candidates.filter((c) => score(c) === best);
  const distance = (c: { last: SideLine }) => Math.abs(c.last.line - placement.line);
  const nearest = Math.min(...top.map(distance));
  const closest = top.filter((c) => distance(c) === nearest);
  if (closest.length !== 1) return undefined;
  const { first, last } = closest[0] as { first: SideLine; last: SideLine };
  return {
    path: file.path,
    line: last.line,
    side: placement.side,
    ...(original.length > 1 ? { startLine: first.line } : {}),
    anchor: anchorOf(first, last),
    lines: original,
  };
}

/** Where "Move to new lines" offers to put an outdated draft: a line (or range) of the diff at the PR's head. */
export interface MoveCandidate {
  path: string;
  line: number;
  side: Side;
  startLine?: number;
}

const squash = (text: string) => text.trim().replace(/\s+/g, " ");

/** How alike two lines read, 0 to 1: the share of character pairs they have in common, ignoring spacing. */
export function lineLikeness(a: string, b: string): number {
  const x = squash(a);
  const y = squash(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const pairs = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const pair = s.slice(i, i + 2);
      out.set(pair, (out.get(pair) ?? 0) + 1);
    }
    return out;
  };
  const px = pairs(x);
  const py = pairs(y);
  let shared = 0;
  for (const [pair, n] of px) shared += Math.min(n, py.get(pair) ?? 0);
  return (2 * shared) / (x.length - 1 + y.length - 1);
}

/**
 * Where an outdated draft's code went at the PR's head, for "Move to new lines": the line on the same side of the same
 * file (or the file it was renamed to) that reads most like the draft's line, with its neighbours as they were
 * counting for it, nearest the old place on a tie. Looser than `findAgain`, which moves drafts on its own: this only
 * offers a place you then accept. Undefined when nothing reads enough like it (the line went, or was rewritten), or
 * when two places are equally good: then you pick a line. A range keeps its length, within the hunk it lands in.
 */
export function moveCandidate(placement: Placement, files: DiffFile[]): MoveCandidate | undefined {
  const file = files.find((f) => f.path === placement.path) ?? files.find((f) => f.previousPath === placement.path);
  if (!file || file.binary || file.patchMissing) return undefined;
  const { anchor } = placement;
  const trivial = squash(anchor.text).length < 3;
  const same = (a: string | undefined, b: string | undefined) =>
    a !== undefined && b !== undefined && squash(a) === squash(b);
  const lines = commentableLines(file, placement.side);
  // A range's lines, first to last, as they read when it was written; the last is the anchor's.
  const original = placement.lines && placement.lines.length > 1 ? placement.lines : [anchor.text];
  const scored = lines.flatMap((l, i) => {
    // The run of lines ending here, within the hunk, as long as the range (shorter at a hunk's start).
    const run = lines.slice(Math.max(0, i - original.length + 1), i + 1).filter((x) => x.hunk === l.hunk);
    const head = run[0] as SideLine;
    const like = lineLikeness(l.text, anchor.text);
    // Every line of a range counts, the last one most.
    const others =
      run.length === original.length && run.length > 1
        ? original.slice(0, -1).reduce((sum, text, k) => sum + lineLikeness((run[k] as SideLine).text, text), 0) /
          (run.length - 1)
        : like;
    const around = (same(head.before, anchor.before) ? 1 : 0) + (same(l.after, anchor.after) ? 1 : 0);
    // Blank lines and lone braces are only themselves when what's around them agrees; anything else must read alike.
    if (trivial ? like < 1 || around === 0 : like < 0.5 || (like < 0.8 && around === 0)) return [];
    return [{ l, score: like * 1.5 + others * 0.5 + around * 0.75 }];
  });
  if (scored.length === 0) return undefined;
  const best = Math.max(...scored.map((c) => c.score));
  const top = scored.filter((c) => best - c.score < 1e-9);
  const distance = (c: { l: SideLine }) => Math.abs(c.l.line - placement.line);
  const nearest = Math.min(...top.map(distance));
  const closest = top.filter((c) => distance(c) === nearest);
  if (closest.length !== 1) return undefined;
  const { l: last } = closest[0] as { l: SideLine };
  const length = placement.startLine !== undefined ? placement.line - placement.startLine + 1 : 1;
  const first =
    length > 1
      ? Math.min(
          ...lines
            .filter((l) => l.hunk === last.hunk && l.line <= last.line && l.line > last.line - length)
            .map((l) => l.line),
        )
      : last.line;
  return {
    path: file.path,
    line: last.line,
    side: placement.side,
    ...(first < last.line ? { startLine: first } : {}),
  };
}

// --- The store --------------------------------------------------------------------------------------------------

interface DraftRow {
  id: string;
  pr: string;
  head_sha: string;
  path: string | null;
  line: number | null;
  start_line: number | null;
  side: string | null;
  anchor: string | null;
  lines: string | null;
  body: string;
  suggestion: string | null;
  source: string;
  state: string;
  link_to: string | null;
  in_reply_to: string | null;
  resolve: number | null;
  /** JSON `{ checkId, title, severity? }` on a comment Alden drafted (see `auto-drafts.ts`). */
  drafted?: string | null;
  created_at: string;
  updated_at: string;
}

/** A draft as stored: the schema's fields, plus the line's text for finding it again. */
export interface StoredDraft extends ReviewDraft {
  anchor?: LineAnchor;
}

function json<T>(text: string | null): T | undefined {
  try {
    return text ? (JSON.parse(text) as T) : undefined;
  } catch {
    return undefined;
  }
}

/** The finding a draft Alden made came from, as `drafted` (its stored severity stays in the row). */
function draftedOf(text: string | null | undefined): Pick<ReviewDraft, "drafted"> {
  const drafted = json<{ checkId?: unknown; title?: unknown }>(text ?? null);
  return typeof drafted?.checkId === "string" && typeof drafted.title === "string"
    ? { drafted: { checkId: drafted.checkId, title: drafted.title } }
    : {};
}

function fromRow(row: DraftRow): StoredDraft {
  const lines = json<string[]>(row.lines);
  const parsedLink = DraftLinkSchema.safeParse(json(row.link_to));
  const link = row.link_to !== null && parsedLink.success ? parsedLink.data : undefined;
  const inline = row.path !== null && row.line !== null;
  const draft = ReviewDraftSchema.parse({
    id: row.id,
    pr: row.pr,
    headSha: row.head_sha,
    ...(inline ? { path: row.path, line: Number(row.line), side: row.side } : {}),
    ...(inline && row.start_line !== null ? { startLine: Number(row.start_line) } : {}),
    ...(inline && Array.isArray(lines) ? { originalLines: lines } : {}),
    body: row.body,
    ...(row.suggestion !== null ? { suggestion: row.suggestion } : {}),
    ...(!inline && link ? { linkTo: link } : {}),
    ...(row.in_reply_to ? { inReplyTo: row.in_reply_to, resolve: row.resolve === 1 } : {}),
    source: row.source,
    ...draftedOf(row.drafted),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    state: row.state,
  });
  const anchor = json<LineAnchor>(row.anchor);
  return anchor ? { ...draft, anchor } : draft;
}

/** Strips the stored-only fields, for anything that leaves the engine. */
export const publicDraft = ({ anchor: _anchor, ...draft }: StoredDraft): ReviewDraft => draft;

/**
 * A PR's drafts as the UI lists them, after `follow` brought them to `headSha`: each outdated draft on a line says
 * the head its lines no longer match at (`changedIn`) and, when it can be told, where its code is now (`movedTo`, see
 * `moveCandidate`).
 */
export function draftsAtHead(list: StoredDraft[], headSha: string, files: DiffFile[]): ReviewDraft[] {
  return list.map((d) => {
    const draft = publicDraft(d);
    if (d.state !== "outdated" || d.path === undefined) return draft;
    const placement = placementOf(d);
    const movedTo = placement ? moveCandidate(placement, files) : undefined;
    return { ...draft, changedIn: headSha, ...(movedTo ? { movedTo } : {}) };
  });
}

const placementOf = (d: StoredDraft): Placement | undefined =>
  d.path !== undefined && d.line !== undefined && d.anchor
    ? {
        path: d.path,
        line: d.line,
        side: d.side ?? "RIGHT",
        anchor: d.anchor,
        ...(d.startLine !== undefined ? { startLine: d.startLine } : {}),
        ...(d.originalLines ? { lines: d.originalLines } : {}),
      }
    : undefined;

/**
 * Checks a comment's text: something to say (or a suggestion, which can stand alone), within GitHub's limit once
 * the suggestion block is added.
 */
export function checkBody(
  body: string,
  suggestion?: string,
  note?: Pick<ReviewDraft, "pr" | "headSha" | "linkTo">,
): string {
  if (body.trim() === "" && suggestion === undefined) throw new Error("A comment needs some text.");
  const text = { body, ...(suggestion !== undefined ? { suggestion } : {}) };
  const length = (note?.linkTo ? noteText({ ...note, ...text }) : commentBody(text)).length;
  if (length > MAX_COMMENT_CHARS) {
    throw new Error(
      `That comment is ${length} characters${suggestion !== undefined ? " with its suggestion" : ""}; GitHub takes at most ${MAX_COMMENT_CHARS}.`,
    );
  }
  return body;
}

/**
 * Checks a suggestion goes where it means something: on a line, or a range, of the new file, where GitHub can apply
 * it; or on a linked note's lines, where it posts as code to copy.
 */
export function checkSuggestion(
  suggestion: string | undefined,
  place: Pick<Placement, "side"> | undefined,
  linkTo?: DraftLink,
): void {
  if (suggestion === undefined) return;
  if (linkTo) {
    if (linkTo.line === undefined) {
      throw new Error("A suggestion replaces lines: link the note to a line (or lines), not a whole file.");
    }
    return;
  }
  if (!place) {
    throw new Error(
      "A suggestion replaces lines of a file: put it on a line (or lines) of the diff, not a general note.",
    );
  }
  if (place.side !== "RIGHT") {
    throw new Error(
      "A suggestion replaces lines in the new file, so it goes on the new side (RIGHT), not on removed lines.",
    );
  }
}

/**
 * The fence for a suggestion block: three backticks, or one more than the longest run of backticks in the code, so
 * nothing in it can close the block early.
 */
export const suggestionFence = (code: string): string => codeFence(code);

/**
 * A line comment as it posts: what you wrote, then (for a suggestion) a blank line and a ```suggestion block with
 * the replacement. An empty suggestion is an empty block, which GitHub offers as deleting the lines.
 */
export function commentBody(draft: { body: string; suggestion?: string | undefined }): string {
  if (draft.suggestion === undefined) return draft.body;
  const fence = suggestionFence(draft.suggestion);
  const block = `${fence}suggestion\n${draft.suggestion === "" ? "" : `${draft.suggestion}\n`}${fence}`;
  return draft.body.trim() === "" ? block : `${draft.body.replace(/\s+$/, "")}\n\n${block}`;
}

/** Drafts, in Alden's local database. Never synced, exported or sent anywhere except by `sendReview`. */
export class ReviewDrafts {
  constructor(private readonly source?: StoreSource) {}

  get store(): AldenStore {
    return storeFrom(this.source);
  }

  /** A PR's drafts ("owner/repo#123"), oldest first. */
  list(pr: string): StoredDraft[] {
    return this.store
      .all<DraftRow>("SELECT * FROM drafts WHERE pr_key = ? ORDER BY created_at, rowid", keyOf(pr))
      .map(fromRow);
  }

  get(id: string): StoredDraft | undefined {
    const row = this.store.get<DraftRow>("SELECT * FROM drafts WHERE id = ?", id);
    return row ? fromRow(row) : undefined;
  }

  /**
   * Adds a draft: on a placed line or range, or (without one) a general note for the review's body, linked to code
   * outside the diff with `linkTo`. With `suggestion`, replacement code for the placed (or linked) lines, on the new
   * side only; its text may then be empty.
   */
  add(
    input: {
      pr: string;
      headSha: string;
      body: string;
      source: ReviewDraft["source"];
      place?: Placement;
      linkTo?: DraftLink;
      suggestion?: string;
    },
    now: Date = new Date(),
  ): StoredDraft {
    const at = now.toISOString();
    const id = randomUUID().replaceAll("-", "").slice(0, 8);
    const { place, suggestion } = input;
    if (place && input.linkTo) throw new Error("A draft goes on a line of the diff or links to one, not both.");
    const linkTo = place ? undefined : input.linkTo && DraftLinkSchema.parse(input.linkTo);
    checkSuggestion(suggestion, place, linkTo);
    this.store.run(
      `INSERT INTO drafts (id, pr, pr_key, head_sha, path, line, start_line, side, anchor, lines, body, suggestion, source,
         state, link_to, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      id,
      input.pr,
      keyOf(input.pr),
      input.headSha,
      place?.path ?? null,
      place?.line ?? null,
      place?.startLine ?? null,
      place?.side ?? null,
      place ? JSON.stringify(place.anchor) : null,
      place?.lines ? JSON.stringify(place.lines) : null,
      checkBody(input.body, suggestion, { pr: input.pr, headSha: input.headSha, linkTo }),
      suggestion ?? null,
      input.source,
      linkTo ? JSON.stringify(linkTo) : null,
      at,
      at,
    );
    this.counted(input.pr, input.source, now);
    return this.get(id) as StoredDraft;
  }

  /** Counts a new draft in the PR's review session under way, for time to review. Never stops the draft. */
  private counted(pr: string, source: ReviewDraft["source"], now: Date): void {
    try {
      noteDrafted(this.store, pr, source, now);
    } catch {
      // only the count is lost
    }
  }

  /**
   * Changes a draft's text or suggestion (`null` removes it), or places it on a line or range again (which brings an
   * outdated draft back, against the code now there), or links it to code outside the diff instead (`linkTo`).
   */
  edit(
    id: string,
    change: {
      body?: string;
      suggestion?: string | null;
      place?: Placement & { headSha: string };
      linkTo?: DraftLink & { headSha: string };
    },
    now: Date = new Date(),
  ): StoredDraft | undefined {
    const draft = this.get(id);
    if (!draft) return undefined;
    if (draft.inReplyTo !== undefined) {
      if (change.place || change.linkTo || change.suggestion !== undefined) {
        throw new Error("A reply posts in its thread: it can't go on a line or carry a suggestion.");
      }
      return this.editReply(id, change.body !== undefined ? { body: change.body } : {}, now);
    }
    if (change.place && change.linkTo) throw new Error("A draft goes on a line of the diff or links to one, not both.");
    const body = change.body ?? draft.body;
    const suggestion = change.suggestion === null ? undefined : (change.suggestion ?? draft.suggestion);
    const linkTo = change.place
      ? undefined
      : change.linkTo
        ? DraftLinkSchema.parse({
            path: change.linkTo.path,
            ...(change.linkTo.line !== undefined ? { line: change.linkTo.line } : {}),
            ...(change.linkTo.startLine !== undefined ? { startLine: change.linkTo.startLine } : {}),
          })
        : draft.linkTo;
    const side =
      change.place?.side ?? (draft.path !== undefined && !change.linkTo ? (draft.side ?? "RIGHT") : undefined);
    checkSuggestion(suggestion, side ? { side } : undefined, linkTo);
    checkBody(body, suggestion, { pr: draft.pr, headSha: change.linkTo?.headSha ?? draft.headSha, linkTo });
    this.store.transaction(() => {
      if (change.body !== undefined || change.suggestion !== undefined) {
        this.store.run(
          "UPDATE drafts SET body = ?, suggestion = ?, updated_at = ? WHERE id = ?",
          body,
          suggestion ?? null,
          now.toISOString(),
          id,
        );
      }
      if (change.place) this.move(id, change.place, now);
      if (change.linkTo && linkTo) this.link(id, { ...linkTo, headSha: change.linkTo.headSha }, now);
    });
    return this.get(id);
  }

  /** Makes a draft a linked note on (new) code at a (new) head, as a draft again: off any line of the diff. */
  link(id: string, link: DraftLink & { headSha: string }, now?: Date): void {
    const { headSha, ...linkTo } = link;
    this.store.run(
      `UPDATE drafts SET path = NULL, line = NULL, start_line = NULL, side = NULL, anchor = NULL, lines = NULL,
         link_to = ?, head_sha = ?, state = 'draft'${now ? ", updated_at = ?" : ""}
       WHERE id = ?`,
      JSON.stringify(linkTo),
      headSha,
      ...(now ? [now.toISOString()] : []),
      id,
    );
  }

  /** Puts a draft on a (new) line or range at a (new) head, as a draft again. */
  move(id: string, place: Placement & { headSha: string }, now?: Date): void {
    this.store.run(
      `UPDATE drafts SET path = ?, line = ?, start_line = ?, side = ?, anchor = ?, lines = ?, head_sha = ?,
         link_to = NULL, state = 'draft'${now ? ", updated_at = ?" : ""}
       WHERE id = ?`,
      place.path,
      place.line,
      place.startLine ?? null,
      place.side,
      JSON.stringify(place.anchor),
      place.lines ? JSON.stringify(place.lines) : null,
      place.headSha,
      ...(now ? [now.toISOString()] : []),
      id,
    );
  }

  /** Deletes a draft, returning what it was. */
  delete(id: string): StoredDraft | undefined {
    const draft = this.get(id);
    if (draft) this.store.run("DELETE FROM drafts WHERE id = ?", id);
    return draft;
  }

  /** Deletes a PR's drafts: after they're sent. */
  clear(pr: string): number {
    return this.store.run("DELETE FROM drafts WHERE pr_key = ?", keyOf(pr)).changes;
  }

  /**
   * Adds a reply to a review thread already on the PR (`threadId`, its GraphQL node id), sent with the review: no
   * place of its own, and no suggestion. With `resolve`, the thread is resolved once the review is submitted; a reply
   * that only resolves has no text. One reply per thread: a second is an edit of the first. Check the thread with
   * `checkThread` first.
   */
  addReply(
    input: {
      pr: string;
      headSha: string;
      threadId: string;
      body: string;
      resolve?: boolean;
      source: ReviewDraft["source"];
    },
    now: Date = new Date(),
  ): StoredDraft {
    const existing = this.list(input.pr).find((d) => d.inReplyTo === input.threadId);
    if (existing) {
      throw new Error(`You're already replying in that thread (${existing.id}): change that reply instead.`);
    }
    const at = now.toISOString();
    const id = randomUUID().replaceAll("-", "").slice(0, 8);
    this.store.run(
      `INSERT INTO drafts (id, pr, pr_key, head_sha, body, source, state, in_reply_to, resolve, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      id,
      input.pr,
      keyOf(input.pr),
      input.headSha,
      checkReply(input.body, input.resolve === true),
      input.source,
      input.threadId,
      input.resolve ? 1 : 0,
      at,
      at,
    );
    this.counted(input.pr, input.source, now);
    return this.get(id) as StoredDraft;
  }

  /** Changes a reply's text, or whether it resolves its thread. Undefined when there's no such draft. */
  editReply(id: string, change: { body?: string; resolve?: boolean }, now: Date = new Date()): StoredDraft | undefined {
    const draft = this.get(id);
    if (!draft) return undefined;
    if (draft.inReplyTo === undefined) throw new Error(`${id} is a comment, not a reply in a thread.`);
    const body = change.body ?? draft.body;
    const resolve = change.resolve ?? draft.resolve === true;
    this.store.run(
      "UPDATE drafts SET body = ?, resolve = ?, updated_at = ? WHERE id = ?",
      checkReply(body, resolve),
      resolve ? 1 : 0,
      now.toISOString(),
      id,
    );
    return this.get(id);
  }

  /**
   * Follows a PR to its current head: a general note simply moves along, a draft on a line moves with its line if
   * it can be found again (see `findAgain`), and is marked outdated (keeping its old place and head) if not. A linked
   * note stays as it is: its link is to the code you saw when you wrote it, at the head it was written against.
   * Returns the drafts that moved or went out of date, by id.
   */
  follow(pr: string, headSha: string, files: DiffFile[]): { moved: string[]; outdated: string[] } {
    const moved: string[] = [];
    const outdated: string[] = [];
    this.store.transaction(() => {
      for (const draft of this.list(pr)) {
        // A reply is tied to its thread, not a line: it stays as written whatever the PR does.
        if (draft.headSha === headSha || draft.linkTo || draft.inReplyTo) continue;
        const placement = placementOf(draft);
        if (draft.path === undefined) {
          this.store.run("UPDATE drafts SET head_sha = ? WHERE id = ?", headSha, draft.id);
          continue;
        }
        const found = placement ? findAgain(placement, files) : undefined;
        if (found) {
          this.move(draft.id, { ...found, headSha });
          moved.push(draft.id);
        } else if (draft.state !== "outdated") {
          this.store.run("UPDATE drafts SET state = 'outdated' WHERE id = ?", draft.id);
          outdated.push(draft.id);
        }
      }
    });
    return { moved, outdated };
  }

  /** Keeps a PR briefing's places to look, replacing the last briefing's: see `unaddressedPlaces`. */
  rememberBriefing(briefing: Briefing): void {
    if (briefing.target.kind !== "pr") return;
    this.store.run(
      "INSERT OR REPLACE INTO briefed_places (pr_key, briefing_at, places) VALUES (?, ?, ?)",
      keyOf(prName(briefing.target.repo, briefing.target.number)),
      briefing.generatedAt,
      JSON.stringify(briefedPlaces(briefing)),
    );
  }

  /** The places to look in a PR's latest briefing, and when it was made. */
  briefed(pr: string): { briefingAt: string; places: BriefedPlace[] } | undefined {
    const row = this.store.get<{ briefing_at: string; places: string }>(
      "SELECT briefing_at, places FROM briefed_places WHERE pr_key = ?",
      keyOf(pr),
    );
    if (!row) return undefined;
    try {
      return { briefingAt: row.briefing_at, places: JSON.parse(row.places) as BriefedPlace[] };
    } catch {
      return undefined;
    }
  }
}

// --- What the review covers -------------------------------------------------------------------------------------

/** The places to look that no draft is near: worth a second look before approving. */
export function unaddressedPlaces(places: BriefedPlace[], drafts: ReviewDraft[]): UnaddressedPlace[] {
  return places
    .filter((place) => !drafts.some((d) => isNear(d, place)))
    .map((place) => ({
      checkId: place.checkId ?? "model",
      title: place.title,
      ...(place.anchor ? { path: place.anchor.path } : {}),
      ...(place.anchor?.line !== undefined ? { line: place.anchor.line } : {}),
    }));
}

/**
 * The review's body as it will post: what you wrote for it, then each general note, oldest first; a linked note with
 * its link to the code it's about first (see `noteText`). Replies aren't notes: they post in their threads.
 */
export function composeReviewBody(body: string | undefined, drafts: ReviewDraft[]): string {
  return [body ?? "", ...drafts.filter((d) => d.path === undefined && d.inReplyTo === undefined).map(noteText)]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** A review comment as GitHub's API takes it: on `line`, or from `start_line` to `line` on the same side. */
export interface ReviewComment {
  path: string;
  start_line?: number;
  start_side?: Side;
  line: number;
  side: Side;
  body: string;
}

/**
 * The request GitHub gets: exactly what you wrote, nothing added except a suggestion's ```suggestion block (see
 * `commentBody`).
 */
export function reviewRequest(
  headSha: string,
  event: ReviewEvent,
  body: string | undefined,
  drafts: ReviewDraft[],
): {
  commit_id: string;
  event: ReviewEvent;
  body?: string;
  comments: ReviewComment[];
} {
  const text = composeReviewBody(body, drafts);
  return {
    commit_id: headSha,
    event,
    ...(text ? { body: text } : {}),
    comments: drafts.flatMap((d): ReviewComment[] => {
      if (d.path === undefined || d.line === undefined) return [];
      const side = d.side ?? "RIGHT";
      return [
        {
          path: d.path,
          ...(d.startLine !== undefined ? { start_line: d.startLine, start_side: side } : {}),
          line: d.line,
          side,
          body: commentBody(d),
        },
      ];
    }),
  };
}

// --- Replies in review threads ----------------------------------------------------------------------------------

/** A draft that replies in (or only resolves) a thread already on the PR. */
export const isReply = (d: Pick<ReviewDraft, "inReplyTo">) => d.inReplyTo !== undefined;

/** Checks a reply's text: something to say, or Resolve ticked with nothing to say; within GitHub's limit. */
export function checkReply(body: string, resolve: boolean): string {
  if (body.trim() === "" && !resolve) throw new Error("A reply needs some text, or Resolve ticked.");
  if (body.length > MAX_COMMENT_CHARS) {
    throw new Error(`That reply is ${body.length} characters; GitHub takes at most ${MAX_COMMENT_CHARS}.`);
  }
  return body.trim() === "" ? "" : body;
}

/** Where a thread is, as it's named everywhere: "src/pay.ts:40", its first line when it's outdated, or the file. */
export function threadWhere(thread: Pick<ReviewThread, "path" | "line" | "startLine" | "originalLine">): string {
  const line = thread.line ?? thread.originalLine;
  if (line === null) return thread.path;
  const start =
    thread.line !== null && thread.startLine !== null && thread.startLine < line ? `${thread.startLine}-` : "";
  return `${thread.path}:${start}${line}`;
}

/** A thread's short id, for `alden comment --threads` and `--reply`: the end of its node id, unique enough on a PR. */
export const shortThreadId = (id: string) => id.slice(-7);

/**
 * The thread a reply means: by its node id or the short id `alden comment --threads` shows, or by `file:line` (the
 * thread's line now, or the line it was started on when it's outdated; an open thread before a resolved one). Says
 * which threads there are when it's none, or which to pick when it's several.
 */
export function findThread(threads: ReviewThread[], ref: string): ReviewThread {
  const text = ref.trim();
  const exact = threads.find((t) => t.id === text);
  if (exact) return exact;
  const byId = text.length >= 4 ? threads.filter((t) => t.id.endsWith(text)) : [];
  if (byId.length === 1) return byId[0] as ReviewThread;
  const at = /^(\S+):(\d+)$/.exec(text);
  if (at) {
    const line = Number(at[2]);
    const here = threads.filter(
      (t) => t.path === at[1] && (t.line === line || (t.line === null && t.originalLine === line)),
    );
    const open = here.filter((t) => !t.isResolved);
    const pick = open.length === 1 ? open : here;
    if (pick.length === 1) return pick[0] as ReviewThread;
    if (pick.length > 1) {
      throw new Error(
        `${pick.length} threads are on ${text}: name one by its id (${pick.map((t) => shortThreadId(t.id)).join(", ")}).`,
      );
    }
  }
  const listed =
    threads.length === 0
      ? "This PR has no review threads."
      : `Its threads: ${threads.map((t) => `${shortThreadId(t.id)} (${threadWhere(t)})`).join(", ")}.`;
  throw new Error(`No review thread ${text} on this PR. ${listed}`);
}

/**
 * Checks you can do what a reply asks in its thread: reply (when it has text: any thread GitHub lets you reply in, yours
 * or not) and resolve (when ticked and the thread isn't resolved already: only a thread you started, and GitHub must
 * let you). Says why not in a sentence.
 */
export function checkThread(
  threads: ReviewThreads | undefined,
  threadId: string,
  want: { reply: boolean; resolve: boolean },
): ReviewThread {
  const thread = threads?.threads.find((t) => t.id === threadId);
  if (!thread) {
    throw new Error("That review thread isn't on the PR any more (it was deleted, or the PR is hidden from you).");
  }
  if (want.reply && !thread.viewerCanReply) {
    throw new Error(`GitHub won't take your reply in the thread on ${threadWhere(thread)} (it may be locked).`);
  }
  // GitHub lets anyone with write access resolve any thread; Alden resolves only yours, so you never close someone
  // else's question for them.
  if (want.resolve && !thread.isResolved && !thread.startedByYou) {
    const who = thread.comments[0]?.author;
    throw new Error(
      `Alden resolves only threads you started, and ${who ? `@${who}` : "someone else"} started the one on ${threadWhere(thread)}: reply instead, and leave resolving it to them.`,
    );
  }
  if (want.resolve && !thread.isResolved && !thread.viewerCanResolve) {
    throw new Error(
      `GitHub won't let you resolve the thread on ${threadWhere(thread)}: that takes write access to the repo, or being the PR's author.`,
    );
  }
  return thread;
}

/** Adds a reply to a thread, inside a pending review: it posts when the review is submitted. */
export const REPLY_MUTATION = `mutation($review: ID!, $thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewId: $review, pullRequestReviewThreadId: $thread, body: $body }) {
    comment { id }
  }
}`;

export const SUBMIT_MUTATION = `mutation($review: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: { pullRequestReviewId: $review, event: $event, body: $body }) {
    pullRequestReview { url }
  }
}`;

export const RESOLVE_MUTATION = `mutation($thread: ID!) {
  resolveReviewThread(input: { threadId: $thread }) { thread { id isResolved } }
}`;

/** What a review with replies did, beyond what `sendReview` already counts. */
interface RepliesSent {
  url: string;
  reviewId?: number;
  replied: number;
  resolved: number;
  notResolved: string[];
}

const said = (error: unknown) => ((error as Error).message ?? String(error)).slice(0, 300);

/**
 * Sends a review that replies in threads already on the PR, or resolves them, in an order where nothing half-posts:
 * 1. the review, pending (no verdict yet), with its line comments and body: one REST request;
 * 2. each reply, into that pending review (GraphQL `addPullRequestReviewThreadReply`);
 * 3. the review submitted with your verdict (`submitPullRequestReview`): only now can anyone see any of it;
 * 4. each thread you ticked, resolved (`resolveReviewThread`): never before the review is submitted.
 * If 2 or 3 fails, the pending review is deleted (its replies with it), and the error says which step failed. A failed
 * resolve can't take back a posted review: it's reported in `notResolved`. With nothing to post (a plain comment with
 * only resolves) there's no review at all, just step 4. Every thread is checked first: still there, and yours to reply
 * in or resolve.
 */
async function sendWithReplies(
  client: GitHubClient,
  input: { repo: string; number: number; event: ReviewEvent; body?: string },
  headSha: string,
  drafts: StoredDraft[],
  replies: StoredDraft[],
): Promise<RepliesSent> {
  const [owner, name] = input.repo.split("/") as [string, string];
  let threads: ReviewThreads | undefined;
  try {
    threads = await fetchReviewThreads(client, input.repo, input.number, "");
  } catch (error) {
    throw new SendReviewError(502, `Not sent: couldn't read the PR's review threads (${said(error)}).`, "github");
  }
  const problems = replies.flatMap((d) => {
    try {
      checkThread(threads, d.inReplyTo as string, { reply: d.body.trim() !== "", resolve: d.resolve === true });
      return [];
    } catch (error) {
      return [{ id: d.id, problem: (error as Error).message }];
    }
  });
  if (problems.length > 0) {
    throw new SendReviewError(
      422,
      `Not sent: ${problems.map((p) => `${p.id}: ${p.problem}`).join(" ")} Change or delete ${problems.length === 1 ? "that reply" : "those replies"}, then send.`,
      "thread",
      problems.map((p) => p.id),
    );
  }
  const threadOf = (d: StoredDraft) => threads?.threads.find((t) => t.id === d.inReplyTo) as ReviewThread;
  const withText = replies.filter((d) => d.body.trim() !== "");
  const toResolve = replies.filter((d) => d.resolve === true && !threadOf(d).isResolved);
  const request = reviewRequest(headSha, input.event, input.body, drafts);
  const posts = input.event !== "COMMENT" || !!request.body || request.comments.length > 0 || withText.length > 0;
  let url = `https://github.com/${input.repo}/pull/${input.number}`;
  let reviewId: number | undefined;

  if (posts) {
    const { event, ...pending } = request;
    let created: { id?: unknown; node_id?: unknown; html_url?: unknown };
    try {
      ({ data: created } = await client.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
        owner,
        repo: name,
        pull_number: input.number,
        ...pending,
        // Never retried: a retry after a timeout could start two reviews.
        request: { retries: 0 },
      }));
    } catch (error) {
      throw sendFailed(error, input.repo, drafts);
    }
    const id = created.id;
    const node = created.node_id;
    /** Takes back the pending review, so none of it posts, and says which step failed. */
    const undo = async (step: string, error: unknown): Promise<never> => {
      let deleted = typeof id === "number";
      if (deleted) {
        try {
          await client.request("DELETE /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}", {
            owner,
            repo: name,
            pull_number: input.number,
            review_id: id as number,
            request: { retries: 0 },
          });
        } catch {
          deleted = false;
        }
      }
      const forbidden = (error as { status?: number }).status === 403;
      throw new SendReviewError(
        forbidden ? 403 : 502,
        `Not sent: GitHub refused ${step} (GitHub said: ${said(error)}). ${
          deleted
            ? "Alden deleted the pending review it had started, so nothing posted."
            : "Alden couldn't delete the pending review it had started: discard it on the PR's page on GitHub, then send again."
        } Your drafts are all still here.`,
        forbidden ? "forbidden" : "github",
      );
    };
    if (typeof node !== "string") await undo("the review", new Error("it didn't say which review it started"));
    for (const d of withText) {
      try {
        await client.graphql(REPLY_MUTATION, {
          review: node,
          thread: d.inReplyTo,
          body: d.body,
          request: { retries: 0 },
        });
      } catch (error) {
        await undo(`your reply in the thread on ${threadWhere(threadOf(d))}`, error);
      }
    }
    try {
      const submitted = await client.graphql<{ submitPullRequestReview?: { pullRequestReview?: { url?: string } } }>(
        SUBMIT_MUTATION,
        { review: node, event, ...(request.body ? { body: request.body } : {}), request: { retries: 0 } },
      );
      url =
        submitted.submitPullRequestReview?.pullRequestReview?.url ??
        (typeof created.html_url === "string" ? created.html_url : url);
    } catch (error) {
      await undo("submitting the review", error);
    }
    if (typeof id === "number") reviewId = id;
  }

  let resolved = 0;
  const notResolved: string[] = [];
  for (const d of toResolve) {
    try {
      await client.graphql(RESOLVE_MUTATION, { thread: d.inReplyTo, request: { retries: 0 } });
      resolved++;
    } catch (error) {
      notResolved.push(`${threadWhere(threadOf(d))}: ${said(error)}`);
    }
  }
  if (!posts && resolved === 0 && notResolved.length > 0) {
    throw new SendReviewError(
      502,
      `Nothing was resolved: ${notResolved.join("; ")}. Your drafts are all still here.`,
      "github",
      toResolve.map((d) => d.id),
    );
  }
  return { url, ...(reviewId !== undefined ? { reviewId } : {}), replied: withText.length, resolved, notResolved };
}

// --- GitHub -----------------------------------------------------------------------------------------------------

/** Why a review wasn't sent. `status` is what the UI's API answers with; `drafts` are the ids it's about. */
export class SendReviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reason: "outdated" | "moved" | "not_in_diff" | "empty" | "forbidden" | "pending" | "thread" | "github",
    readonly drafts: string[] = [],
  ) {
    super(message);
  }
}

/** A PR's current head commit and its diff, from GitHub. Asks for the head again if a push lands in between. */
export async function fetchPullRequestState(
  client: GitHubClient,
  repo: string,
  number: number,
): Promise<{ headSha: string; files: DiffFile[] }> {
  const [owner, name] = repo.split("/") as [string, string];
  const head = async () =>
    (await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo: name, pull_number: number }))
      .data.head.sha as string;
  let headSha = await head();
  for (let attempt = 0; ; attempt++) {
    const files = await fetchPullRequestDiff(client, repo, number);
    const now = await head();
    if (now === headSha || attempt === 2) return { headSha: now, files };
    headSha = now;
  }
}

const where = (d: ReviewDraft) =>
  d.inReplyTo !== undefined
    ? "a reply in a thread"
    : d.path === undefined
      ? d.linkTo
        ? `a note linking to ${linkText(d.linkTo)}`
        : "general note"
      : `${d.path}:${d.startLine !== undefined ? `${d.startLine}-` : ""}${d.line}`;

/** Checks everything GitHub would refuse before asking it, and says which drafts are the problem. */
export function checkSendable(
  drafts: StoredDraft[],
  files: DiffFile[],
  event: ReviewEvent,
  body: string | undefined,
): void {
  const outdated = drafts.filter((d) => d.state === "outdated");
  if (outdated.length > 0) {
    throw new SendReviewError(
      409,
      `Not sent: ${outdated.length === 1 ? "a comment's line" : `${outdated.length} comments' lines`} changed since you wrote ${outdated.length === 1 ? "it" : "them"} (${outdated.map((d) => `${d.id} on ${where(d)}`).join(", ")}). Place ${outdated.length === 1 ? "it" : "each"} on a line again, or delete ${outdated.length === 1 ? "it" : "them"}, then send.`,
      "outdated",
      outdated.map((d) => d.id),
    );
  }
  const problems = drafts.flatMap((d) => {
    if (d.path === undefined || d.line === undefined) return [];
    const placed = placeOnDiff(files, d.path, d.line, d.side ?? "RIGHT", d.startLine);
    if ("problem" in placed) return [{ id: d.id, problem: placed.problem }];
    // A suggestion is applied as-is: it must still replace exactly the code it was written against.
    const same = !d.originalLines || JSON.stringify(d.originalLines) === JSON.stringify(placed.lines);
    if (d.suggestion !== undefined && !same) {
      return [{ id: d.id, problem: `The code its suggestion replaces (${where(d)}) changed: place it again.` }];
    }
    return [];
  });
  if (problems.length > 0) {
    throw new SendReviewError(
      422,
      `Not sent: GitHub won't take ${problems.length === 1 ? "this comment" : "these comments"}: ${problems.map((p) => `${p.id}: ${p.problem}`).join(" ")}`,
      "not_in_diff",
      problems.map((p) => p.id),
    );
  }
  const text = composeReviewBody(body, drafts);
  const inline = drafts.some((d) => d.path !== undefined);
  // A reply says something in its thread; one that only resolves still does something when sent.
  const replies = drafts.some((d) => d.inReplyTo !== undefined && (d.body.trim() !== "" || d.resolve === true));
  if (event === "COMMENT" && !text && !inline && !replies) {
    throw new SendReviewError(400, "Nothing to send: write a comment or a review body first.", "empty");
  }
  if (event === "REQUEST_CHANGES" && !text) {
    throw new SendReviewError(
      400,
      "Requesting changes needs a review body saying what to change: add one, or a general note.",
      "empty",
    );
  }
}

/** Turns GitHub's refusal of a review into what to do about it. */
function sendFailed(error: unknown, repo: string, drafts: StoredDraft[]): SendReviewError {
  const status = (error as { status?: number }).status;
  const message = ((error as Error).message ?? String(error)).slice(0, 300);
  if (status === 403 || status === 404) {
    return new SendReviewError(
      403,
      `Your GitHub sign-in can't write reviews on ${repo} (GitHub said: ${message}).`,
      "forbidden",
    );
  }
  if (status === 422 && /pending review/i.test(message)) {
    return new SendReviewError(
      409,
      `You have a review in progress on GitHub for this PR. Submit or discard it there, then send again. (GitHub said: ${message})`,
      "pending",
    );
  }
  if (status === 422) {
    const inline = drafts.filter((d) => d.path !== undefined);
    const about = /line|diff|position|path/i.test(message) && inline.length > 0;
    return new SendReviewError(
      422,
      `GitHub refused the review: ${message}.${about ? ` It's about one of these comments' lines: ${inline.map((d) => `${d.id} on ${where(d)}`).join(", ")}. If the PR just moved, look them over and send again.` : ""}`,
      "not_in_diff",
      about ? inline.map((d) => d.id) : [],
    );
  }
  return new SendReviewError(502, `GitHub didn't take the review: ${message}`, "github");
}

/** What a sent review was made of, as counts, for the local record and telemetry. Never any text. */
export interface SentCounts {
  inline: number;
  notes: number;
  fromYou: number;
  fromClaude: number;
  hasBody: boolean;
  /** Line comments carrying a suggested change. */
  suggestions: number;
  /** General notes linking to code outside the diff (counted in `notes` too). */
  linked: number;
  unaddressed: number;
  /** Places to look that the review's comments were near, and so taught Alden "useful" (new this review). */
  learned: number;
  /** Review signals recorded, by kind: see `learnFromReview`. */
  signals: Record<ReviewSignalKind, number>;
}

/**
 * How a sent review teaches Alden: `fromReviews` is the `learning.fromReviews` setting, `seen` what you saw.
 * `reviewTime` is the `stats.reviewTime` setting: on (the default), the send ends the PR's review session and the
 * result carries its `timing`; off, the session under way is dropped.
 */
export interface SendLearning {
  fromReviews?: boolean;
  seen?: SeenReader;
  reviewTime?: boolean;
}

/**
 * Sends a PR's drafts as one review: brings them to the PR's current head, refuses if that moved or outdated any
 * inline comment (so what posts is what you last saw), checks every line against the diff, then makes one
 * POST /repos/{owner}/{repo}/pulls/{n}/reviews. With replies in existing threads (or threads to resolve) it takes a few
 * steps instead, in an order where nothing half-posts: see `sendWithReplies`. Afterwards: a local `review_sent` event (counts only), what the review
 * taught (see `learnFromReview` and `confirmNotes`; never stops the send, which has posted by then), where each line
 * comment went (kept 30 days, to see later whether it was applied or resolved: see `checkOutcomes`), and the PR's
 * drafts are deleted.
 */
export async function sendReview(
  client: GitHubClient,
  store: AldenStore,
  input: {
    repo: string;
    number: number;
    event: ReviewEvent;
    body?: string;
    /**
     * Leaves out the drafts you already saw were outdated (the UI's summary counts them as "Outdated, left out")
     * rather than refusing to send; they stay, to move or delete. A draft this send finds outdated still stops it.
     */
    leaveOutdated?: boolean;
  },
  now: Date = new Date(),
  learning: SendLearning = {},
): Promise<SendReviewResult & { counts: SentCounts; timing?: ReviewTiming }> {
  const pr = prName(input.repo, input.number);
  const drafts = new ReviewDrafts(store);
  const { headSha, files } = await fetchPullRequestState(client, input.repo, input.number);
  const before = drafts.list(pr);
  // Alden's drafts you haven't kept don't post, so their moving doesn't stop the review.
  const unkept = new Set(before.filter((d) => d.source === "alden").map((d) => d.id));
  const leftOut = new Set(
    input.leaveOutdated ? before.filter((d) => d.state === "outdated" && !unkept.has(d.id)).map((d) => d.id) : [],
  );
  const followed = drafts.follow(pr, headSha, files);
  const changed = [...followed.moved, ...followed.outdated].filter((id) => !unkept.has(id) && !leftOut.has(id));
  if (changed.length > 0) {
    throw new SendReviewError(
      409,
      `Not sent: the PR has new commits. ${followed.moved.length} comment${followed.moved.length === 1 ? "" : "s"} moved to follow ${followed.moved.length === 1 ? "its line" : "their lines"}${followed.outdated.length ? `, and ${followed.outdated.length} couldn't be found again` : ""}. Look them over, then send again.`,
      "moved",
      changed,
    );
  }
  // Only what's yours posts: a comment Alden drafted goes out once you keep or edit it, never on its own.
  const all = drafts.list(pr).filter((d) => d.source !== "alden" && !leftOut.has(d.id));
  checkSendable(all, files, input.event, input.body);
  // Replies post in their threads: they're not the review's own comments, to count or learn from.
  const replies = all.filter(isReply);
  const pending = all.filter((d) => !isReply(d));

  const [owner, name] = input.repo.split("/") as [string, string];
  let url: string;
  let reviewId: number | undefined;
  let threads: Omit<RepliesSent, "url" | "reviewId"> | undefined;
  if (replies.length > 0) {
    const sent = await sendWithReplies(client, input, headSha, pending, replies);
    ({ url, reviewId } = sent);
    threads = sent;
  } else {
    try {
      const { data } = await client.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
        owner,
        repo: name,
        pull_number: input.number,
        ...reviewRequest(headSha, input.event, input.body, pending),
        // Never retried: a retry after a timeout could post the review twice.
        request: { retries: 0 },
      });
      url = (data as { html_url?: string }).html_url ?? `https://github.com/${input.repo}/pull/${input.number}`;
      const id = (data as { id?: unknown }).id;
      if (typeof id === "number") reviewId = id;
    } catch (error) {
      throw sendFailed(error, input.repo, pending);
    }
  }

  const inline = pending.filter((d) => d.path !== undefined);
  const briefed = drafts.briefed(pr);
  const { signals, notes } = briefed
    ? await learnSafely(store, { ...input, headSha }, briefed, pending, learning, now)
    : { signals: [], notes: [] };
  const lines =
    signals.length > 0 || notes.length > 0 ? await progressSafely(store, input.repo, signals, notes, pr) : [];
  const counts: SentCounts = {
    inline: inline.length,
    notes: pending.length - inline.length,
    fromYou: pending.filter((d) => d.source === "you").length,
    fromClaude: pending.filter((d) => d.source === "claude").length,
    hasBody: (input.body ?? "").trim() !== "",
    suggestions: inline.filter((d) => d.suggestion !== undefined).length,
    linked: pending.filter((d) => d.linkTo !== undefined).length,
    unaddressed: briefed ? unaddressedPlaces(briefed.places, pending).length : 0,
    learned: signals.filter((s) => s.signal !== "silent_pass" && s.signal !== "miss").length + notes.length,
    signals: signalCounts(signals),
  };
  if (reviewId !== undefined && learning.fromReviews !== false) {
    // What came of these comments (applied, resolved) is checked later: see `checkOutcomes`. Never fails the send.
    try {
      rememberSentComments(
        store,
        { repo: input.repo, number: input.number, reviewId, headSha, sentAt: now.toISOString() },
        inline.flatMap((d) => (d.line === undefined ? [] : [sentComment(d, briefed?.places ?? [])])),
      );
    } catch {
      // the review is sent; only its outcomes go unlearned
    }
  }
  store.addEvent({
    id: randomUUID(),
    at: now.toISOString(),
    type: "review_sent",
    repo: input.repo,
    body: { pr, number: input.number, headSha, review: input.event, url, at: now.toISOString(), ...counts },
  });
  // The outdated drafts left out stay, to move or delete; everything else was sent or (Alden's, unkept) let go.
  if (leftOut.size === 0) drafts.clear(pr);
  else for (const d of drafts.list(pr)) if (!leftOut.has(d.id)) drafts.delete(d.id);
  // How long the review took (stats.reviewTime): the session ends here. Never fails the send, which has posted.
  let timing: ReviewTiming | undefined;
  try {
    if (learning.reviewTime === false) dropReviewSession(store, pr, now);
    else
      timing = closeReviewSession(
        store,
        { pr, verdict: input.event, comments: pending.length + (threads?.replied ?? 0) },
        now,
      );
  } catch {
    // the review is sent; only its timing is lost
  }
  return {
    url,
    posted: pending.length + (threads?.replied ?? 0),
    review: input.event,
    ...(threads ? { replies: threads.replied, resolved: threads.resolved } : {}),
    ...(threads?.notResolved.length ? { notResolved: threads.notResolved } : {}),
    ...(lines.length > 0 ? { learning: lines } : {}),
    counts,
    ...(timing ? { timing } : {}),
  };
}

/** A sent line comment as `rememberSentComments` keeps it, with the check of the first flagged place it was near. */
function sentComment(draft: StoredDraft, places: LookHere[]): SentCommentInput {
  const near = places.find((place) => place.checkId !== undefined && isNear(draft, place));
  return {
    path: draft.path as string,
    line: draft.line as number,
    ...(draft.startLine !== undefined ? { startLine: draft.startLine } : {}),
    side: draft.side ?? "RIGHT",
    ...(draft.suggestion !== undefined ? { suggestion: draft.suggestion } : {}),
    ...(draft.originalLines ? { lines: draft.originalLines } : {}),
    ...(near?.checkId !== undefined ? { checkId: near.checkId } : {}),
  };
}

// --- Learning ---------------------------------------------------------------------------------------------------

/**
 * What the review taught, recorded: review signals for Alden's checks (`learnFromReview`), and the notes it confirmed
 * (`confirmNotes`). Nothing (rather than an error) if that fails, since the review has posted.
 */
async function learnSafely(
  store: AldenStore,
  pr: { repo: string; number: number; event: ReviewEvent; headSha: string },
  briefed: { briefingAt: string; places: BriefedPlace[] },
  drafts: ReviewDraft[],
  learning: SendLearning,
  now: Date,
): Promise<{ signals: ReviewSignalEvent[]; notes: string[] }> {
  const enabled = learning.fromReviews !== undefined ? { enabled: learning.fromReviews } : {};
  let signals: ReviewSignalEvent[] = [];
  let notes: string[] = [];
  try {
    signals = await learnFromReview(store, pr, pr.event, briefed, drafts, {
      ...enabled,
      ...(learning.seen ? { seen: learning.seen } : {}),
      now,
    });
  } catch {
    // Learned nothing for the checks.
  }
  try {
    notes = await confirmNotes(store, pr, briefed, drafts, { ...enabled, now });
  } catch {
    // Confirmed no note.
  }
  return { signals, notes };
}

/** Where the lessons the review moved now stand, as lines (see `reviewProgress`), then each note it confirmed. */
async function progressSafely(
  store: AldenStore,
  repo: string,
  signals: Parameters<typeof reviewProgress>[1],
  notes: string[],
  pr: string,
): Promise<string[]> {
  try {
    const learning = await loadLearning(store, repo);
    return [
      ...reviewProgress(learning, signals, pr),
      ...notes.flatMap((id) => {
        const note = learning.notes.find((n) => n.id === id);
        return note ? [`Your review of ${pr} confirmed your note "${note.text}" (confirmed ${note.confirmed}×).`] : [];
      }),
    ];
  } catch {
    return [];
  }
}
