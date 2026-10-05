import { createHash, randomUUID } from "node:crypto";
import {
  type Briefing,
  FEEDBACK_SCHEMA_VERSION,
  FeedbackEventSchema,
  type FeedbackItem,
  type LookHere,
  type ReviewDraft,
  ReviewDraftSchema,
  type ReviewEvent,
  type SendReviewResult,
  type UnaddressedPlace,
} from "@alden/schema";
import type { DiffFile } from "../diff/parse.js";
import { fetchPullRequestDiff } from "../diff/sources.js";
import { FeedbackLog } from "../feedback/log.js";
import type { GitHubClient } from "../github/client.js";
import { dismissKey } from "../learn/learn.js";
import type { AldenStore } from "../store/db.js";
import { type StoreSource, storeFrom } from "../store/source.js";

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

/** Where an inline draft sits: a line on one side of a file's diff. */
export interface Placement {
  path: string;
  line: number;
  side: Side;
  anchor: LineAnchor;
}

/** How far (in lines) a comment can be from a flagged place and still count as about it. */
export const NEAR_LINES = 3;
/** GitHub's own limit on a comment's length. */
export const MAX_COMMENT_CHARS = 65_536;

export const prName = (repo: string, number: number) => `${repo}#${number}`;
const keyOf = (pr: string) => pr.toLowerCase();

// --- Lines in the diff ------------------------------------------------------------------------------------------

interface SideLine extends LineAnchor {
  line: number;
}

/**
 * The lines GitHub takes comments on, on one side of a file's diff: added and unchanged lines on the right, removed
 * and unchanged lines on the left. Each carries its neighbours within the hunk.
 */
export function commentableLines(file: DiffFile, side: Side): SideLine[] {
  const out: SideLine[] = [];
  for (const hunk of file.hunks) {
    const lines = hunk.lines.filter((l) => (side === "RIGHT" ? l.kind !== "del" : l.kind !== "add"));
    lines.forEach((l, i) => {
      const line = side === "RIGHT" ? l.newLine : l.oldLine;
      if (line === undefined) return;
      const before = lines[i - 1]?.text;
      const after = lines[i + 1]?.text;
      out.push({
        line,
        text: l.text,
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
      });
    });
  }
  return out;
}

/** Places a comment on a line of the diff, or says (in a sentence) why GitHub wouldn't take one there. */
export function placeOnDiff(
  files: DiffFile[],
  path: string,
  line: number,
  side: Side = "RIGHT",
): Placement | { problem: string } {
  const file = files.find((f) => f.path === path);
  if (!file) return { problem: `${path} isn't changed in this PR, so GitHub won't take a comment on it.` };
  if (file.binary || file.patchMissing) {
    return {
      problem: `GitHub doesn't show ${path}'s diff (it's binary or too large), so there's no line to comment on. Write a general note instead.`,
    };
  }
  const found = commentableLines(file, side).find((l) => l.line === line);
  if (!found) {
    const where = side === "LEFT" ? " on the old side" : "";
    return {
      problem: `Line ${line} of ${path} isn't in this PR's diff${where}: GitHub only takes comments on changed lines and the few shown around them.`,
    };
  }
  const { line: _line, ...anchor } = found;
  return { path, line, side, anchor };
}

/**
 * Finds a draft's line again in a newer diff: the same text on the same side of the same file (or the file it was
 * renamed to), preferring the candidate whose neighbours still match, then the one nearest the old line. Undefined
 * when the line changed, left the diff, or can't be told apart from others like it: an `outdated` draft, which you
 * place again rather than have Alden guess.
 */
export function findAgain(placement: Placement, files: DiffFile[]): Placement | undefined {
  const file = files.find((f) => f.path === placement.path) ?? files.find((f) => f.previousPath === placement.path);
  if (!file) return undefined;
  const { anchor } = placement;
  const score = (l: SideLine) =>
    (anchor.before !== undefined && l.before === anchor.before ? 1 : 0) +
    (anchor.after !== undefined && l.after === anchor.after ? 1 : 0);
  const candidates = commentableLines(file, placement.side).filter((l) => l.text === anchor.text);
  if (candidates.length === 0) return undefined;
  const best = Math.max(...candidates.map(score));
  // A blank line or a lone brace is only itself when something around it agrees.
  if (anchor.text.trim().length < 3 && best === 0) return undefined;
  const top = candidates.filter((l) => score(l) === best);
  const distance = (l: SideLine) => Math.abs(l.line - placement.line);
  const nearest = Math.min(...top.map(distance));
  const closest = top.filter((l) => distance(l) === nearest);
  if (closest.length !== 1) return undefined;
  const { line, ...moved } = closest[0] as SideLine;
  return { path: file.path, line, side: placement.side, anchor: moved };
}

// --- The store --------------------------------------------------------------------------------------------------

interface DraftRow {
  id: string;
  pr: string;
  head_sha: string;
  path: string | null;
  line: number | null;
  side: string | null;
  anchor: string | null;
  body: string;
  source: string;
  state: string;
  created_at: string;
  updated_at: string;
}

/** A draft as stored: the schema's fields, plus the line's text for finding it again. */
export interface StoredDraft extends ReviewDraft {
  anchor?: LineAnchor;
}

function fromRow(row: DraftRow): StoredDraft {
  const draft = ReviewDraftSchema.parse({
    id: row.id,
    pr: row.pr,
    headSha: row.head_sha,
    ...(row.path !== null && row.line !== null ? { path: row.path, line: Number(row.line), side: row.side } : {}),
    body: row.body,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    state: row.state,
  });
  let anchor: LineAnchor | undefined;
  try {
    anchor = row.anchor ? (JSON.parse(row.anchor) as LineAnchor) : undefined;
  } catch {
    anchor = undefined;
  }
  return anchor ? { ...draft, anchor } : draft;
}

/** Strips the stored-only fields, for anything that leaves the engine. */
export const publicDraft = ({ anchor: _anchor, ...draft }: StoredDraft): ReviewDraft => draft;

const placementOf = (d: StoredDraft): Placement | undefined =>
  d.path !== undefined && d.line !== undefined && d.anchor
    ? { path: d.path, line: d.line, side: d.side ?? "RIGHT", anchor: d.anchor }
    : undefined;

/** Checks a comment's text: something to say, within GitHub's limit. */
export function checkBody(body: string): string {
  if (body.trim() === "") throw new Error("A comment needs some text.");
  if (body.length > MAX_COMMENT_CHARS) {
    throw new Error(`That comment is ${body.length} characters; GitHub takes at most ${MAX_COMMENT_CHARS}.`);
  }
  return body;
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

  /** Adds a draft: on a placed line, or (without one) a general note for the review's body. */
  add(
    input: { pr: string; headSha: string; body: string; source: ReviewDraft["source"]; place?: Placement },
    now: Date = new Date(),
  ): StoredDraft {
    const at = now.toISOString();
    const id = randomUUID().replaceAll("-", "").slice(0, 8);
    const { place } = input;
    this.store.run(
      `INSERT INTO drafts (id, pr, pr_key, head_sha, path, line, side, anchor, body, source, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      id,
      input.pr,
      keyOf(input.pr),
      input.headSha,
      place?.path ?? null,
      place?.line ?? null,
      place?.side ?? null,
      place ? JSON.stringify(place.anchor) : null,
      checkBody(input.body),
      input.source,
      at,
      at,
    );
    return this.get(id) as StoredDraft;
  }

  /** Changes a draft's text, or places it on a line again (which brings an outdated draft back). */
  edit(
    id: string,
    change: { body?: string; place?: Placement & { headSha: string } },
    now: Date = new Date(),
  ): StoredDraft | undefined {
    const draft = this.get(id);
    if (!draft) return undefined;
    if (change.body !== undefined) {
      this.store.run(
        "UPDATE drafts SET body = ?, updated_at = ? WHERE id = ?",
        checkBody(change.body),
        now.toISOString(),
        id,
      );
    }
    if (change.place) this.move(id, change.place, now);
    return this.get(id);
  }

  /** Puts a draft on a (new) line at a (new) head, as a draft again. */
  move(id: string, place: Placement & { headSha: string }, now?: Date): void {
    this.store.run(
      `UPDATE drafts SET path = ?, line = ?, side = ?, anchor = ?, head_sha = ?, state = 'draft'${now ? ", updated_at = ?" : ""}
       WHERE id = ?`,
      place.path,
      place.line,
      place.side,
      JSON.stringify(place.anchor),
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
   * it can be found again (see `findAgain`), and is marked outdated (keeping its old place and head) if not. Returns
   * the drafts that moved or went out of date, by id.
   */
  follow(pr: string, headSha: string, files: DiffFile[]): { moved: string[]; outdated: string[] } {
    const moved: string[] = [];
    const outdated: string[] = [];
    this.store.transaction(() => {
      for (const draft of this.list(pr)) {
        if (draft.headSha === headSha) continue;
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
      JSON.stringify(briefing.needsYourEyes),
    );
  }

  /** The places to look in a PR's latest briefing, and when it was made. */
  briefed(pr: string): { briefingAt: string; places: LookHere[] } | undefined {
    const row = this.store.get<{ briefing_at: string; places: string }>(
      "SELECT briefing_at, places FROM briefed_places WHERE pr_key = ?",
      keyOf(pr),
    );
    if (!row) return undefined;
    try {
      return { briefingAt: row.briefing_at, places: JSON.parse(row.places) as LookHere[] };
    } catch {
      return undefined;
    }
  }
}

// --- What the review covers -------------------------------------------------------------------------------------

/** Whether a draft is about a flagged place: on the same file, within `NEAR_LINES` of its line (any line if none). */
export function isNear(draft: ReviewDraft, place: LookHere): boolean {
  if (!place.anchor || draft.path !== place.anchor.path || draft.line === undefined) return false;
  if (place.anchor.line === undefined) return true;
  return (draft.side ?? "RIGHT") === "RIGHT" && Math.abs(draft.line - place.anchor.line) <= NEAR_LINES;
}

/** The places to look that no draft is near: worth a second look before approving. */
export function unaddressedPlaces(places: LookHere[], drafts: ReviewDraft[]): UnaddressedPlace[] {
  return places
    .filter((place) => !drafts.some((d) => isNear(d, place)))
    .map((place) => ({
      checkId: place.checkId ?? "model",
      title: place.title,
      ...(place.anchor ? { path: place.anchor.path } : {}),
      ...(place.anchor?.line !== undefined ? { line: place.anchor.line } : {}),
    }));
}

/** The review's body as it will post: what you wrote for it, then each general note, oldest first. */
export function composeReviewBody(body: string | undefined, drafts: ReviewDraft[]): string {
  return [body ?? "", ...drafts.filter((d) => d.path === undefined).map((d) => d.body)]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** The request GitHub gets: exactly what you wrote, nothing added. */
export function reviewRequest(
  headSha: string,
  event: ReviewEvent,
  body: string | undefined,
  drafts: ReviewDraft[],
): {
  commit_id: string;
  event: ReviewEvent;
  body?: string;
  comments: { path: string; line: number; side: Side; body: string }[];
} {
  const text = composeReviewBody(body, drafts);
  return {
    commit_id: headSha,
    event,
    ...(text ? { body: text } : {}),
    comments: drafts.flatMap((d) =>
      d.path !== undefined && d.line !== undefined
        ? [{ path: d.path, line: d.line, side: d.side ?? "RIGHT", body: d.body }]
        : [],
    ),
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

const where = (d: ReviewDraft) => (d.path === undefined ? "general note" : `${d.path}:${d.line}`);

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
    const placed = placeOnDiff(files, d.path, d.line, d.side ?? "RIGHT");
    return "problem" in placed ? [{ id: d.id, problem: placed.problem }] : [];
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
  unaddressed: number;
  /** Places to look that the review's comments were near, and so taught Alden "useful". */
  learned: number;
}

/**
 * Sends a PR's drafts as one review: brings them to the PR's current head, refuses if that moved or outdated any
 * inline comment (so what posts is what you last saw), checks every line against the diff, then makes one
 * POST /repos/{owner}/{repo}/pulls/{n}/reviews. Afterwards: a local `review_sent` event (counts only), "useful" for
 * each flagged place a comment was near (see `learnFromComments`), and the PR's drafts are deleted.
 */
export async function sendReview(
  client: GitHubClient,
  store: AldenStore,
  input: { repo: string; number: number; event: ReviewEvent; body?: string },
  now: Date = new Date(),
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
  const learned = briefed ? await learnFromComments(store, input, briefed, inline, now) : 0;
  const counts: SentCounts = {
    inline: inline.length,
    notes: pending.length - inline.length,
    fromYou: pending.filter((d) => d.source === "you").length,
    fromClaude: pending.filter((d) => d.source === "claude").length,
    hasBody: (input.body ?? "").trim() !== "",
    unaddressed: briefed ? unaddressedPlaces(briefed.places, pending).length : 0,
    learned,
  };
  store.addEvent({
    id: randomUUID(),
    at: now.toISOString(),
    type: "review_sent",
    repo: input.repo,
    body: { pr, number: input.number, headSha, review: input.event, url, at: now.toISOString(), ...counts },
  });
  drafts.clear(pr);
  return { url, posted: pending.length, review: input.event, counts };
}

// --- Learning ---------------------------------------------------------------------------------------------------

/**
 * A comment you sent near a flagged place is the strongest "useful" there is: it's recorded as a verdict (`agree`,
 * marked `via: "comment"`) on that place, so it counts toward the check's lesson like a click on "useful". Once per
 * place per PR (the event's id is derived from the place), and never over a verdict you gave that place yourself.
 */
export async function learnFromComments(
  store: AldenStore,
  pr: { repo: string; number: number },
  briefed: { briefingAt: string; places: LookHere[] },
  inline: ReviewDraft[],
  now: Date = new Date(),
): Promise<number> {
  const target = `${pr.repo.toLowerCase()}#${pr.number}`;
  const inForce = new Map<string, string>();
  for (const event of await new FeedbackLog(store).events(pr.repo)) {
    if (event.kind !== "verdict" || event.target.kind !== "pr" || event.target.number !== pr.number) continue;
    inForce.set(dismissKey(target, event.item), event.verdict);
  }
  let learned = 0;
  for (const place of briefed.places) {
    if (!inline.some((d) => isNear(d, place))) continue;
    const item: FeedbackItem = {
      source: place.source ?? "check",
      ...(place.checkId ? { checkId: place.checkId } : {}),
      title: place.title,
      ...(place.anchor ? { anchor: place.anchor } : {}),
      placement: "eyes",
    };
    const key = dismissKey(target, item);
    const verdict = inForce.get(key);
    if (verdict !== undefined && verdict !== "clear") continue;
    const id = `comment-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
    const event = FeedbackEventSchema.parse({
      schemaVersion: FEEDBACK_SCHEMA_VERSION,
      id,
      at: now.toISOString(),
      kind: "verdict",
      target: { kind: "pr", repo: pr.repo, number: pr.number },
      briefingAt: briefed.briefingAt,
      item,
      verdict: "agree",
      via: "comment",
    });
    // The id is the place's: a second review on the same PR doesn't count it again.
    const before = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE id = ?", id)?.n ?? 0;
    store.addEvent({ id, at: event.at, type: "feedback", repo: pr.repo, body: event });
    if (Number(before) === 0) learned++;
  }
  return learned;
}
