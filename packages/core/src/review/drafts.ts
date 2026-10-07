import { randomUUID } from "node:crypto";
import {
  type Briefing,
  codeFence,
  type DraftLink,
  DraftLinkSchema,
  linkLines,
  noteText,
  type ReviewDraft,
  ReviewDraftSchema,
  type ReviewEvent,
  type ReviewSignalEvent,
  type ReviewSignalKind,
  type SendReviewResult,
  type UnaddressedPlace,
} from "@alden/schema";
import type { DiffFile } from "../diff/parse.js";
import { fetchPullRequestDiff } from "../diff/sources.js";
import { signalCounts } from "../feedback/log.js";
import type { GitHubClient } from "../github/client.js";
import { loadLearning, reviewProgress } from "../learn/learn.js";
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
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    state: row.state,
  });
  const anchor = json<LineAnchor>(row.anchor);
  return anchor ? { ...draft, anchor } : draft;
}

/** Strips the stored-only fields, for anything that leaves the engine. */
export const publicDraft = ({ anchor: _anchor, ...draft }: StoredDraft): ReviewDraft => draft;

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
    return this.get(id) as StoredDraft;
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
        if (draft.headSha === headSha || draft.linkTo) continue;
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
 * its link to the code it's about first (see `noteText`).
 */
export function composeReviewBody(body: string | undefined, drafts: ReviewDraft[]): string {
  return [body ?? "", ...drafts.filter((d) => d.path === undefined).map(noteText)]
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

// --- GitHub -----------------------------------------------------------------------------------------------------

/** Why a review wasn't sent. `status` is what the UI's API answers with; `drafts` are the ids it's about. */
export class SendReviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reason: "outdated" | "moved" | "not_in_diff" | "empty" | "forbidden" | "pending" | "github",
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
  d.path === undefined
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
  if (event === "COMMENT" && !text && !inline) {
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

/** How a sent review teaches Alden: `fromReviews` is the `learning.fromReviews` setting, `seen` what you saw. */
export interface SendLearning {
  fromReviews?: boolean;
  seen?: SeenReader;
}

/**
 * Sends a PR's drafts as one review: brings them to the PR's current head, refuses if that moved or outdated any
 * inline comment (so what posts is what you last saw), checks every line against the diff, then makes one
 * POST /repos/{owner}/{repo}/pulls/{n}/reviews. Afterwards: a local `review_sent` event (counts only), what the review
 * taught (see `learnFromReview`; never stops the send, which has posted by then), and the PR's drafts are deleted.
 */
export async function sendReview(
  client: GitHubClient,
  store: AldenStore,
  input: { repo: string; number: number; event: ReviewEvent; body?: string },
  now: Date = new Date(),
  learning: SendLearning = {},
): Promise<SendReviewResult & { counts: SentCounts }> {
  const pr = prName(input.repo, input.number);
  const drafts = new ReviewDrafts(store);
  const { headSha, files } = await fetchPullRequestState(client, input.repo, input.number);
  const followed = drafts.follow(pr, headSha, files);
  const changed = [...followed.moved, ...followed.outdated];
  if (changed.length > 0) {
    throw new SendReviewError(
      409,
      `Not sent: the PR has new commits. ${followed.moved.length} comment${followed.moved.length === 1 ? "" : "s"} moved to follow ${followed.moved.length === 1 ? "its line" : "their lines"}${followed.outdated.length ? `, and ${followed.outdated.length} couldn't be found again` : ""}. Look them over, then send again.`,
      "moved",
      changed,
    );
  }
  const pending = drafts.list(pr);
  checkSendable(pending, files, input.event, input.body);

  const [owner, name] = input.repo.split("/") as [string, string];
  let url: string;
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
  } catch (error) {
    throw sendFailed(error, input.repo, pending);
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
  store.addEvent({
    id: randomUUID(),
    at: now.toISOString(),
    type: "review_sent",
    repo: input.repo,
    body: { pr, number: input.number, headSha, review: input.event, url, at: now.toISOString(), ...counts },
  });
  drafts.clear(pr);
  return {
    url,
    posted: pending.length,
    review: input.event,
    ...(lines.length > 0 ? { learning: lines } : {}),
    counts,
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
