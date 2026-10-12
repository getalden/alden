import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import { COMMIT_SHA, MAX_ACTIVE_REPORT_MS, MAX_QUESTION_CHARS, type RankChange, type ReviewStage } from "@alden/core";
import {
  type AskEvent,
  type Briefing,
  BriefingSchema,
  type BriefingTarget,
  BriefingTargetSchema,
  type DraftTone,
  DraftToneSchema,
  FollowUpLevelSchema,
  type LocalSetupEvent,
  ModelPickSchema,
  type PrDiff,
  type RankRule,
  type ReviewDraft,
  type ReviewDrafts,
  type ReviewThreads,
  type ReviewEvent as ReviewVerdict,
  type SendReviewResult,
  type ToneState,
} from "@alden/schema";
import { briefingFileName, briefingMarkdown } from "../render/markdown.js";
import { stripControlDeep } from "../render/style.js";
import type { FollowUpsApi } from "./follow-ups.js";
import type { ModelSetupApi, SetupPage } from "./model-setup.js";
import type { RankingApi } from "./rank.js";

/** A review request from the UI. `pr` is a URL, owner/repo#123 or a queue number; without it, local changes. */
export interface ReviewRequest {
  pr?: string;
  llm?: boolean;
  graph?: boolean;
  model?: string;
  effort?: string;
  /**
   * Where you opened it, for learning which queue rows you open: the web UI unless said. The interactive terminal
   * says "cli". Never taken from the HTTP request.
   */
  opened?: "cli" | "ui";
}

/** One line of a streamed review. */
export type ReviewEvent =
  | { type: "stage"; stage: ReviewStage; label: string }
  | { type: "briefing"; briefing: Briefing }
  | { type: "error"; message: string };

/** What the server asks of the engine. Tests pass fakes; `alden ui` passes the real thing (see api.ts). */
export interface UiApi {
  session(): Promise<unknown>;
  /** `cached`: the last queue (up to a day old) if there is one, instead of waiting for GitHub. */
  queue(options: { refresh: boolean; repos: string[]; orgs: string[]; cached?: boolean }): Promise<unknown>;
  review(request: ReviewRequest, onStage: (stage: ReviewStage, label: string) => void): Promise<Briefing>;
  /**
   * The desktop app, while you're away: briefs the first of the top PRs waiting on you that has no briefing for its
   * latest push. `{ prepared: null }` when there's nothing to do (or it's off).
   */
  prepareNext(): Promise<unknown>;
  /** Without a PR, which briefings are ready; with one ("owner/repo#12"), that briefing, or null if none or stale. */
  prepared(pr?: string): Promise<unknown>;
  /**
   * Whether a briefing (by its target) still matches the PR on GitHub: fresh, the PR has new commits, or its base has
   * moved. One GitHub request; the UI asks when it shows a briefing and when the window regains focus.
   */
  freshness(target: BriefingTarget): Promise<unknown>;
  /** GitHub sign-in from the UI: start the device flow, its status, open GitHub's page, or use the GitHub CLI's. */
  startSignIn(): Promise<unknown>;
  signInStatus(): Promise<unknown>;
  openSignIn(): Promise<unknown>;
  useGitHubCli(): Promise<unknown>;
  /** Removes the GitHub sign-in Alden stored (the avatar menu's Sign out); says what still signs you in. */
  signOut(): Promise<{ remaining: string | null }>;
  /**
   * Stores an API key in the keychain, as `alden auth model` does: Anthropic's or OpenAI's, told apart by its shape.
   * `null` removes the stored key of `provider` (Anthropic's unless said). Write-only: the answer says whose key it was
   * and where that provider's key now comes from, never the key.
   */
  setModelKey(key: string | null, provider?: "anthropic" | "openai"): Promise<unknown>;
  /** "Set up a model": what's available, testing and storing a key, a local model through Ollama (see model-setup.ts). */
  modelSetup: ModelSetupApi;
  /** Follow-ups on PRs you reviewed, for the desktop app's notifications, and each PR's own level (see follow-ups.ts). */
  followUps: FollowUpsApi;
  /** Settings → Ranking: your weights and rules (`[queue.rank]`), `background.prepare`, and a preview (see rank.ts). */
  ranking: RankingApi;
  /** The local clone PR briefings on `repo` ("owner/name") find callers in, or null when there's none. */
  clone(repo: string): Promise<unknown>;
  /** The desktop app's `alden` command: whether it's installed, and installing it. */
  cliStatus(): Promise<unknown>;
  installCli(): Promise<unknown>;
  /**
   * The desktop app's "Save as Markdown": writes the briefing to the Downloads folder (the Tauri window can't download
   * files) and says where, `~` for the home folder.
   */
  saveBriefing(briefing: Briefing): Promise<{ path: string; shown: string }>;
  spend(): Promise<unknown>;
  config(): Promise<unknown>;
  /** `null` removes the setting, so its default applies again. */
  setConfig(key: string, value: string | null): Promise<unknown>;
  /** Records a verdict or a miss; returns the stored event. */
  addFeedback(input: unknown): Promise<unknown>;
  feedbackSummary(): Promise<unknown>;
  stats(options: { repo?: string; days: number; since?: string; refresh: boolean }): Promise<unknown>;
  /** What Alden knows about the reviewer in a repo (default: the repo `alden ui` was started in). */
  memory(repo?: string): Promise<unknown>;
  addMemory(input: { repo?: string; text: string }): Promise<unknown>;
  forgetMemory(input: { repo?: string; id: string }): Promise<unknown>;
  /** The rest of the Memory view: edit a note, undo a forget, pause or resume learning, forget everything. */
  changeMemory(input: MemoryChange): Promise<unknown>;
  /** Repos Alden knows something about, for the Memory view's list. */
  memoryRepos(): Promise<unknown>;
  /** A reaction to a PR in the last queue: "owner/repo#12". */
  react(input: { pr: string; reaction: "up" | "down" | "dismiss" | "clear" }): Promise<unknown>;
  /** Feedback events with repo names, titles, paths and notes removed, as `alden feedback --export` writes them. */
  exportFeedback(): Promise<unknown>;
  /** The desktop app can't download files: the redacted feedback export, written to Downloads. */
  saveFeedback(): Promise<{ path: string; shown: string; events: number }>;
  /** The desktop app's window can't open tabs: a link you clicked, opened in your default browser. */
  openLink(url: string): Promise<{ opened: string }>;
  /** Whether anonymous usage stats are on, off or not yet asked, and anything forcing them off. */
  telemetry(): Promise<unknown>;
  setTelemetry(on: boolean): Promise<unknown>;
  /**
   * A PR's pending review ("owner/repo#12", a URL or a queue number): its drafts, brought to the PR's current head
   * (moved with their lines, or marked outdated), and the places its latest briefing flagged that no draft is near.
   */
  drafts(pr: string): Promise<ReviewDrafts>;
  /** Adds a draft at the PR's current head. The UI's are yours; Claude Code's (through `alden mcp`) are "claude". */
  addDraft(input: DraftInput, source?: ReviewDraft["source"]): Promise<ReviewDraft>;
  editDraft(id: string, change: DraftChange): Promise<ReviewDraft>;
  deleteDraft(id: string): Promise<{ ok: true }>;
  /**
   * Keeps Alden's drafts, by id or every one on a PR: each becomes yours and is sent with the review. Untouched, they
   * never are. Dropping one is `deleteDraft`.
   */
  keepDrafts(input: { ids?: string[]; pr?: string }): Promise<{ kept: ReviewDraft[] }>;
  /**
   * "Draft my review": one model call that drafts Alden's comments (Keep, Edit or Drop, never sent untouched) for the
   * places to look and the model's findings in the PR's latest briefing, at its current head, that have no comment of
   * yours near them. Within your budget caps; never on a PR with text aimed at AI reviewers.
   */
  draftReview(input: { pr: string; tone?: DraftTone }): Promise<DraftReviewAnswer>;
  /**
   * "Draft with Alden": the text of one comment (on a line, or a general note) or a reply in a thread, from the code
   * there or from what you've written so far (`text`). One small model call; it saves nothing. `signal` stops it.
   */
  suggestText(input: SuggestTextInput, signal?: AbortSignal): Promise<{ text: string; costUsd: number | null }>;
  /**
   * The tone Alden drafts in for a repo ("owner/name"): its own on this machine, or the global `drafts.tone`. Without
   * a repo, the global one.
   */
  tone(repo?: string): Promise<ToneState>;
  /** Sets a repo's tone (null removes it, back to the global one), or without a repo the global `drafts.tone`. */
  setTone(input: { repo?: string; tone: DraftTone | null }): Promise<ToneState>;
  /**
   * A question about a PR, answered by the model with its latest briefing (at the current head), the diff around the
   * places that matter and your notes, in one call within your caps. `onText` hears the answer as it's written;
   * `signal` stops it. Throws an `ApiError`: 409 (no model, no briefing for this head, text aimed at AI reviewers,
   * over budget), 502 (the provider failed).
   */
  ask(
    input: { pr: string; question: string; model?: string },
    onText: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<{ costUsd: number | null; model: string }>;
  /**
   * Sends the PR's drafts to GitHub as one review, and deletes them once it's posted. The only call that writes to
   * GitHub: it runs on your click or command, never in the background, and Claude Code has no tool for it.
   */
  sendReview(input: { pr: string; event: ReviewVerdict; body?: string }): Promise<SendReviewResult>;
  /**
   * The Diff tab: a PR's diff at its current head ("owner/repo#12", a URL or a queue number), or without one the local
   * changes a briefing of them covers. A PR's diff is kept per head commit, so opening it again costs one request.
   * `since` (a commit: the head you last reviewed) narrows a PR's diff to what changed from it to the head, or says
   * it couldn't (`since.applied` false) and gives the whole PR.
   */
  diff(pr?: string, since?: string): Promise<PrDiff>;
  /**
   * A PR's review threads ("owner/repo#12", a URL or a queue number): the conversation already on it, each comment marked
   * when it's yours. Read only; kept briefly per PR, `refresh` asks GitHub again.
   */
  threads(pr: string, refresh?: boolean): Promise<ReviewThreads>;
  /**
   * The flagged places you saw in a PR at a head commit (a guided step, a marker in the Diff tab), so a review that
   * passes them without a word can teach Alden. Kept on this machine only; nothing is recorded while
   * `learning.fromReviews` is off.
   */
  recordSeen(input: SeenInput): Promise<{ recorded: number }>;
  /**
   * Time to review: active time the UI measured on a PR ("owner/repo#12"), its pane visible and focused, idle
   * stretches over 2 minutes left out, added to the PR's review session under way. Nothing while `stats.reviewTime`
   * is off, or without a session (its briefing not opened yet, or the review already sent).
   */
  reportActive(input: { pr: string; activeMs: number }): Promise<{ counted: boolean }>;
  /** Time to review over the last 14, 30 and 90 days, from the review sessions on this machine. */
  reviewTime(): Promise<unknown>;
}

/** What `POST /api/seen` takes: a PR ("owner/repo#12"), the head commit its places are from, and the places. */
export interface SeenInput {
  pr: string;
  headSha: string;
  places: { checkId?: string; path: string; line?: number; how: "guided" | "diff" }[];
}

/** The most places one `POST /api/seen` takes: the UI sends a few at a time. */
export const MAX_SEEN_PLACES = 50;
const MAX_SEEN_BYTES = 16 * 1024;

/** A `POST /api/seen` body, checked: anything else is a 400. */
export function seenFrom(body: Record<string, unknown>): SeenInput {
  const fail = () =>
    new ApiError(
      400,
      `Send { pr: owner/repo#12, headSha, places: [{ checkId?, path, line?, how: guided | diff }] }, up to ${MAX_SEEN_PLACES} places.`,
    );
  const { pr, headSha, places } = body;
  if (typeof pr !== "string" || !/^[\w.-]+\/[\w.-]+#\d{1,9}$/.test(pr)) throw fail();
  if (typeof headSha !== "string" || !/^[0-9a-f]{7,64}$/i.test(headSha)) throw fail();
  if (!Array.isArray(places) || places.length === 0 || places.length > MAX_SEEN_PLACES) throw fail();
  return {
    pr,
    headSha,
    places: places.map((place: unknown) => {
      if (!place || typeof place !== "object") throw fail();
      const { checkId, path, line, how } = place as Record<string, unknown>;
      if (typeof path !== "string" || path.length === 0 || path.length > 1024) throw fail();
      if (checkId !== undefined && (typeof checkId !== "string" || !/^[\w.:-]{1,100}$/.test(checkId))) throw fail();
      if (line !== undefined && !(Number.isInteger(line) && (line as number) > 0)) throw fail();
      if (how !== "guided" && how !== "diff") throw fail();
      return {
        ...(checkId !== undefined ? { checkId: checkId as string } : {}),
        path,
        ...(line !== undefined ? { line: line as number } : {}),
        how,
      };
    }),
  };
}

/**
 * A new draft: on `path` at `line` (on `side`, default RIGHT), or from `startLine` to `line` (one hunk, one side), or
 * without them a general note for the review's body. When GitHub won't take a comment there (a line outside the
 * PR's diff, a file it doesn't change, or `path` alone for a whole file), it's a linked note instead: a general note
 * with `linkTo`, posted in the body with a link to that code at the PR's head. `suggestion` is replacement code for
 * those lines, on the RIGHT side only (on a linked note, code to copy); with one, `body` may be empty.
 */
export interface DraftInput {
  pr: string;
  path?: string;
  line?: number;
  startLine?: number;
  side?: "RIGHT" | "LEFT";
  body: string;
  suggestion?: string;
  /**
   * A reply in a review thread already on the PR (its node id) instead: no place or suggestion of its own. `resolve`
   * resolves the thread once the review is sent; with it, `body` may be empty.
   */
  inReplyTo?: string;
  resolve?: boolean;
  /** Its text came from "Draft with Alden": counted (never the text) as an assisted comment, edited or not. */
  assisted?: { edited: boolean };
}

/** What "Draft my review" did: drafts made, places skipped for a comment already near them, and what it cost. */
export interface DraftReviewAnswer {
  made: number;
  skipped: number;
  /** Places the model was asked about: 0 when every place already had a comment, and nothing was asked. */
  asked: number;
  /** null when no call was made, or the model has no known price. */
  costUsd: number | null;
  drafts: ReviewDraft[];
}

/** What "Draft with Alden" is for: a line (or file), a thread (a reply), or neither (a general note). */
export interface SuggestTextInput {
  pr: string;
  path?: string;
  line?: number;
  startLine?: number;
  side?: "RIGHT" | "LEFT";
  threadId?: string;
  /** What you've written so far: what you mean, to make into a clear comment. */
  text?: string;
  /** The tone for this comment; the repo's tone when absent. */
  tone?: DraftTone;
}

/**
 * A change to a draft: its text, its suggestion (`null` removes it), or (with `path` and `line`, and `startLine` for a
 * range) a new place, which brings an outdated draft back: inline, or a linked note when it's outside the diff.
 */
export interface DraftChange {
  body?: string;
  suggestion?: string | null;
  /** On a reply: whether it resolves its thread. */
  resolve?: boolean;
  path?: string;
  line?: number;
  startLine?: number;
  side?: "RIGHT" | "LEFT";
  /** The new text came from "Draft with Alden" (see `DraftInput.assisted`). */
  assisted?: { edited: boolean };
}

export type MemoryChange =
  | { repo?: string; action: "edit"; id: string; text: string }
  | { repo?: string; action: "restore"; id: string }
  | { repo?: string; action: "exclude" | "include"; id: string; path: string }
  | { repo?: string; action: "learning"; on: boolean }
  | { repo?: string; action: "forget-all" };

/** An error the UI should show as is, with an HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface UiServerOptions {
  api: UiApi;
  /** The built UI (index.html and assets). Missing: a page that says how to build it. */
  staticDir?: string;
  /** The built UI's files by relative path, for a standalone binary; used instead of `staticDir`. */
  files?: Map<string, Uint8Array>;
  port?: number;
  /** Fixed in tests; random otherwise. */
  token?: string;
}

export interface UiServer {
  server: Server;
  port: number;
  token: string;
  /** Where to point the browser: the token rides in the fragment, which browsers never send to servers. */
  url: string;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

const MAX_BODY_BYTES = 64 * 1024;
/** A briefing sent back to be exported: up to ten places, every check's evidence, the model's findings. */
const MAX_BRIEFING_BYTES = 4 * 1024 * 1024;

/** A web link to open in the browser: http or https only, and never Alden's own page (its key is in the link). */
export function webLink(value: unknown): string {
  let url: URL;
  try {
    url = new URL(typeof value === "string" ? value : "");
  } catch {
    throw new ApiError(400, "Send { url }, a web link.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ApiError(400, "Only web links open.");
  if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new ApiError(400, "That's Alden's own page.");
  return url.href;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" });
  // PR text (titles, branches, paths) can carry terminal escape codes; the UI would show them as text.
  res.end(JSON.stringify(stripControlDeep(body)));
}

async function readJsonBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new ApiError(413, "Request too large.");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new ApiError(400, "Expected a JSON object.");
}

/** The briefing in a request to export one: `{ briefing }`, as the review sent it. */
async function briefingFrom(req: IncomingMessage): Promise<Briefing> {
  const body = await readJsonBody(req, MAX_BRIEFING_BYTES);
  const parsed = BriefingSchema.safeParse(body.briefing);
  if (!parsed.success) throw new ApiError(400, "Send { briefing }, a briefing as a review returned it.");
  return parsed.data;
}

/**
 * A draft's place from a request: `path` and `line` (and optionally `side` and `startLine`), `path` alone for a whole
 * file (a linked note), or nothing.
 */
function placeFrom(
  body: Record<string, unknown>,
): Pick<DraftInput, "path" | "line" | "side" | "startLine"> | undefined {
  if (body.path === undefined && body.line === undefined) {
    if (body.startLine !== undefined)
      throw new ApiError(400, "A startLine needs { path, line } too: line is the range's last line.");
    return undefined;
  }
  const sides = ["RIGHT", "LEFT"] as const;
  const side = sides.find((s) => s === body.side);
  const { line, startLine } = body;
  if (
    typeof body.path !== "string" ||
    !body.path ||
    (line !== undefined && (typeof line !== "number" || !Number.isInteger(line) || line < 1)) ||
    (body.side !== undefined && !side)
  ) {
    throw new ApiError(
      400,
      "A comment on code needs { path, line } (line a positive whole number; leave it out for a whole file), and side RIGHT or LEFT.",
    );
  }
  if (startLine !== undefined && (typeof startLine !== "number" || !Number.isInteger(startLine) || startLine < 1)) {
    throw new ApiError(400, "startLine is a range's first line: a positive whole number, less than line.");
  }
  if (startLine !== undefined && line === undefined) {
    throw new ApiError(400, "A startLine needs a line too: line is the range's last line.");
  }
  return {
    path: body.path,
    ...(typeof line === "number" ? { line } : {}),
    ...(side ? { side } : {}),
    ...(startLine !== undefined ? { startLine } : {}),
  };
}

/** Whether a request asks to resolve a reply's thread: true or false, or nothing. */
function resolveFrom(body: Record<string, unknown>): boolean | undefined {
  if (body.resolve === undefined) return undefined;
  if (typeof body.resolve !== "boolean") throw new ApiError(400, "resolve is true or false.");
  return body.resolve;
}

/** Whether a draft's text came from "Draft with Alden": `{ edited }`, or nothing. */
function assistedFrom(body: Record<string, unknown>): { assisted?: { edited: boolean } } {
  const { assisted } = body;
  if (assisted === undefined) return {};
  if (
    typeof assisted !== "object" ||
    assisted === null ||
    typeof (assisted as { edited?: unknown }).edited !== "boolean"
  ) {
    throw new ApiError(400, "assisted is { edited: true | false }: whether you changed Alden's text before saving.");
  }
  return { assisted: { edited: (assisted as { edited: boolean }).edited } };
}

/** A repo as "owner/name". */
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

/** A one-off tone from a request (`tone`), or undefined when it doesn't say. Anything else is refused. */
function toneFrom(body: Record<string, unknown>): DraftTone | undefined {
  if (body.tone === undefined) return undefined;
  const tone = DraftToneSchema.safeParse(body.tone);
  if (!tone.success) throw new ApiError(400, `tone is one of ${DraftToneSchema.options.join(", ")}.`);
  return tone.data;
}

/** A reply from a request: the thread's node id (`inReplyTo`) and `resolve`; undefined when it isn't a reply. */
function replyFrom(body: Record<string, unknown>): { inReplyTo: string; resolve?: boolean } | undefined {
  const resolve = resolveFrom(body);
  if (body.inReplyTo === undefined) {
    if (resolve !== undefined) throw new ApiError(400, "resolve goes with inReplyTo: only a reply resolves a thread.");
    return undefined;
  }
  if (typeof body.inReplyTo !== "string" || !/^[\w=-]{1,200}$/.test(body.inReplyTo)) {
    throw new ApiError(400, "inReplyTo is a review thread's id, as GET /api/threads lists it.");
  }
  return { inReplyTo: body.inReplyTo, ...(resolve !== undefined ? { resolve } : {}) };
}

/** A suggestion from a request: replacement code (a string, empty to delete the lines), or nothing. */
function suggestionFrom(body: Record<string, unknown>, removable: boolean): { suggestion?: string | null } {
  if (body.suggestion === undefined) return {};
  if (typeof body.suggestion === "string" || (removable && body.suggestion === null)) {
    return { suggestion: body.suggestion };
  }
  throw new ApiError(
    400,
    `suggestion is the replacement code, as a string (empty deletes the lines)${removable ? ", or null to remove it" : ""}.`,
  );
}

/**
 * A ranking change from a request: `weights` (numbers, or null for the default), `rules` (a list, checked against the
 * schema when saved) and `prepare` (a whole number, or null for the default). Anything else is refused.
 */
function rankChangeFrom(body: Record<string, unknown>): RankChange {
  const usage =
    "Send { weights?: { name: number | null }, rules?: [{ when, then, by?, name? }], prepare?: number | null }.";
  const known = new Set(["weights", "rules", "prepare"]);
  if (Object.keys(body).some((k) => !known.has(k))) throw new ApiError(400, usage);
  const { weights, rules, prepare } = body;
  if (
    weights !== undefined &&
    (typeof weights !== "object" ||
      weights === null ||
      Array.isArray(weights) ||
      Object.values(weights).some((w) => w !== null && typeof w !== "number"))
  ) {
    throw new ApiError(400, usage);
  }
  if (rules !== undefined && !Array.isArray(rules)) throw new ApiError(400, usage);
  if (prepare !== undefined && prepare !== null && typeof prepare !== "number") throw new ApiError(400, usage);
  const change: RankChange = {};
  if (weights !== undefined) change.weights = weights as NonNullable<RankChange["weights"]>;
  if (rules !== undefined) change.rules = rules as RankRule[];
  if (prepare !== undefined) change.prepare = prepare as number | null;
  return change;
}

const sameToken = (given: string | undefined, token: string) =>
  given !== undefined && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));

/**
 * The local server behind `alden ui`: the built UI plus a JSON API over the engine, on 127.0.0.1 only.
 *
 * The API holds a GitHub token and can spend model money, so every call must carry the session token (from the URL
 * fragment, sent as `X-Alden-Token`), and the Host header must be this server's own address. That keeps out other
 * websites in the same browser (they can't read the token, and DNS rebinding changes the Host) and other users on
 * the machine (they can't see the token).
 */
export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const token = options.token ?? randomBytes(24).toString("base64url");
  let port = options.port ?? 0;
  const hostsAllowed = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof ApiError) send(res, error.status, { error: error.message });
      else send(res, 500, { error: (error as Error).message ?? "Something went wrong." });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostsAllowed().has(req.headers.host ?? "")) {
      send(res, 403, { error: "Wrong host." });
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (!url.pathname.startsWith("/api/")) {
      await serveStatic(url.pathname, res);
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !hostsAllowed().has(origin.replace(/^http:\/\//, ""))) {
      send(res, 403, { error: "Wrong origin." });
      return;
    }
    if (!sameToken(req.headers["x-alden-token"] as string | undefined, token)) {
      send(res, 401, { error: "Missing or wrong session token. Open the link `alden ui` printed." });
      return;
    }
    await route(req, res, url);
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { api } = options;
    const key = `${req.method} ${url.pathname}`;
    const draft = /^\/api\/drafts\/([\w-]{1,64})$/.exec(url.pathname);
    if (draft && (req.method === "PATCH" || req.method === "DELETE")) {
      const id = draft[1] as string;
      if (req.method === "DELETE") {
        send(res, 200, await api.deleteDraft(id));
        return;
      }
      const body = await readJsonBody(req);
      const place = placeFrom(body);
      const suggestion = suggestionFrom(body, true);
      const resolve = resolveFrom(body);
      if (
        (body.body !== undefined && typeof body.body !== "string") ||
        (body.body === undefined && body.suggestion === undefined && !place && resolve === undefined)
      ) {
        throw new ApiError(
          400,
          "Send { body?, suggestion? }, or { path, line?, side?, startLine? } to place it on a line again, or { resolve } on a reply.",
        );
      }
      send(
        res,
        200,
        await api.editDraft(id, {
          ...(typeof body.body === "string" ? { body: body.body } : {}),
          ...suggestion,
          ...place,
          ...(resolve !== undefined ? { resolve } : {}),
          ...assistedFrom(body),
        }),
      );
      return;
    }
    switch (key) {
      case "GET /api/session":
        send(res, 200, await api.session());
        return;
      case "GET /api/queue":
        send(
          res,
          200,
          await api.queue({
            refresh: url.searchParams.get("refresh") === "1",
            repos: url.searchParams.getAll("repo"),
            orgs: url.searchParams.getAll("org"),
            ...(url.searchParams.get("cached") === "1" ? { cached: true } : {}),
          }),
        );
        return;
      case "POST /api/review":
        await streamReview(await readJsonBody(req), res);
        return;
      case "POST /api/prepare":
        send(res, 200, await api.prepareNext());
        return;
      case "GET /api/prepared": {
        const pr = url.searchParams.get("pr") ?? undefined;
        send(res, 200, await api.prepared(pr));
        return;
      }
      case "POST /api/freshness": {
        const body = await readJsonBody(req);
        const target = BriefingTargetSchema.safeParse(body.target);
        if (!target.success) throw new ApiError(400, "Send { target }: a briefing's target.");
        send(res, 200, await api.freshness(target.data));
        return;
      }
      case "GET /api/spend":
        send(res, 200, await api.spend());
        return;
      case "GET /api/config":
        send(res, 200, await api.config());
        return;
      case "PUT /api/config": {
        const body = await readJsonBody(req);
        if (typeof body.key !== "string" || !(typeof body.value === "string" || body.value === null)) {
          throw new ApiError(400, "Send { key, value }: value a string, or null to remove the setting.");
        }
        send(res, 200, await api.setConfig(body.key, body.value));
        return;
      }
      case "GET /api/stats": {
        const days = Number(url.searchParams.get("days") ?? 90);
        const repo = url.searchParams.get("repo") ?? undefined;
        const since = url.searchParams.get("since") ?? undefined;
        send(
          res,
          200,
          await api.stats({
            days,
            refresh: url.searchParams.get("refresh") === "1",
            ...(repo ? { repo } : {}),
            ...(since ? { since } : {}),
          }),
        );
        return;
      }
      case "GET /api/feedback":
        send(res, 200, await api.feedbackSummary());
        return;
      case "POST /api/feedback":
        send(res, 200, await api.addFeedback(await readJsonBody(req)));
        return;
      case "GET /api/memory": {
        const repo = url.searchParams.get("repo") ?? undefined;
        send(res, 200, await api.memory(repo));
        return;
      }
      case "POST /api/memory": {
        const body = await readJsonBody(req);
        if (typeof body.text !== "string") throw new ApiError(400, "Send { text }, and optionally { repo }.");
        send(
          res,
          200,
          await api.addMemory({ text: body.text, ...(typeof body.repo === "string" ? { repo: body.repo } : {}) }),
        );
        return;
      }
      case "GET /api/memory/repos":
        send(res, 200, await api.memoryRepos());
        return;
      case "POST /api/memory/change": {
        const body = await readJsonBody(req);
        const repo = typeof body.repo === "string" ? { repo: body.repo } : {};
        const change: MemoryChange | undefined =
          body.action === "edit" && typeof body.id === "string" && typeof body.text === "string"
            ? { ...repo, action: "edit", id: body.id, text: body.text }
            : body.action === "restore" && typeof body.id === "string"
              ? { ...repo, action: "restore", id: body.id }
              : (body.action === "exclude" || body.action === "include") &&
                  typeof body.id === "string" &&
                  typeof body.path === "string"
                ? { ...repo, action: body.action, id: body.id, path: body.path }
                : body.action === "learning" && typeof body.on === "boolean"
                  ? { ...repo, action: "learning", on: body.on }
                  : body.action === "forget-all"
                    ? { ...repo, action: "forget-all" }
                    : undefined;
        if (!change)
          throw new ApiError(400, "Send { action: edit | restore | exclude | include | learning | forget-all, … }.");
        send(res, 200, await api.changeMemory(change));
        return;
      }
      case "POST /api/reaction": {
        const body = await readJsonBody(req);
        const reactions = ["up", "down", "dismiss", "clear"] as const;
        const reaction = reactions.find((r) => r === body.reaction);
        if (typeof body.pr !== "string" || !reaction) {
          throw new ApiError(400, "Send { pr: owner/repo#12, reaction: up | down | dismiss | clear }.");
        }
        send(res, 200, await api.react({ pr: body.pr, reaction }));
        return;
      }
      case "POST /api/auth/device":
        send(res, 200, await api.startSignIn());
        return;
      case "GET /api/auth/device":
        send(res, 200, await api.signInStatus());
        return;
      case "POST /api/auth/device/open":
        send(res, 200, await api.openSignIn());
        return;
      case "POST /api/auth/gh":
        send(res, 200, await api.useGitHubCli());
        return;
      case "POST /api/auth/sign-out":
        send(res, 200, await api.signOut());
        return;
      case "PUT /api/model-key": {
        const body = await readJsonBody(req);
        const provider = body.provider === "openai" ? "openai" : body.provider === undefined ? undefined : "anthropic";
        if (
          !(typeof body.key === "string" || body.key === null) ||
          (body.provider !== undefined && body.provider !== "anthropic" && body.provider !== "openai")
        ) {
          throw new ApiError(
            400,
            "Send { key }: an Anthropic or OpenAI API key, or null (with provider: anthropic | openai) to remove the stored one.",
          );
        }
        send(res, 200, provider ? await api.setModelKey(body.key, provider) : await api.setModelKey(body.key));
        return;
      }
      case "GET /api/model-setup":
        send(res, 200, await api.modelSetup.state());
        return;
      case "POST /api/model-setup/test-key": {
        const body = await readJsonBody(req);
        if (typeof body.key !== "string")
          throw new ApiError(400, "Send { key }, and { untested: true } to skip the check.");
        // The answer says whether it works and where the key now comes from; never the key.
        send(res, 200, await api.modelSetup.testKey(body.key, body.untested === true));
        return;
      }
      case "POST /api/model-setup/local": {
        const body = await readJsonBody(req);
        if (typeof body.model !== "string" || !body.model.trim()) throw new ApiError(400, "Send { model }.");
        await streamLocalSetup(body.model.trim(), res);
        return;
      }
      case "GET /api/models":
        send(res, 200, await api.modelSetup.models());
        return;
      case "PUT /api/models": {
        const pick = ModelPickSchema.safeParse(await readJsonBody(req));
        if (!pick.success) {
          throw new ApiError(
            400,
            "Send { provider: anthropic | openai | ollama | bedrock | vertex | foundry, model }.",
          );
        }
        send(res, 200, await api.modelSetup.pickModel(pick.data));
        return;
      }
      case "POST /api/model-setup/open": {
        const body = await readJsonBody(req);
        const pages: SetupPage[] = ["keys", "openaiKeys", "cloud", "ollama"];
        const page = pages.find((p) => p === body.page);
        if (!page) throw new ApiError(400, "Send { page: keys | openaiKeys | cloud | ollama }.");
        send(res, 200, await api.modelSetup.open(page));
        return;
      }
      case "GET /api/rank":
        send(res, 200, await api.ranking.state());
        return;
      case "PUT /api/rank": {
        const body = await readJsonBody(req);
        send(res, 200, await api.ranking.save(rankChangeFrom(body)));
        return;
      }
      case "POST /api/rank/preview": {
        const body = await readJsonBody(req);
        const { weights, rules } = rankChangeFrom(body);
        if (weights && Object.values(weights).some((w) => w === null)) {
          throw new ApiError(400, "A preview takes numbers for weights, not null.");
        }
        send(
          res,
          200,
          await api.ranking.preview({
            ...(weights ? { weights: weights as Record<string, number> } : {}),
            ...(rules ? { rules } : {}),
          }),
        );
        return;
      }
      case "GET /api/follow-ups":
        send(res, 200, await api.followUps.check());
        return;
      case "POST /api/follow-ups/ack": {
        const body = await readJsonBody(req);
        const { events } = body;
        if (!Array.isArray(events) || events.length > 500 || !events.every((e) => typeof e === "string")) {
          throw new ApiError(400, "Send { events: [id, …] }, the ids a notification covered.");
        }
        send(res, 200, await api.followUps.ack(events as string[]));
        return;
      }
      case "POST /api/follow-ups/seen": {
        const { pr } = await readJsonBody(req);
        if (typeof pr !== "string" || !pr.trim() || pr.length > 300) {
          throw new ApiError(400, "Send { pr: owner/repo#12 }, the PR you opened.");
        }
        send(res, 200, await api.followUps.seen(pr.trim()));
        return;
      }
      case "GET /api/watch":
      case "PUT /api/watch": {
        const pr = url.searchParams.get("pr")?.trim();
        if (!pr) throw new ApiError(400, "Send ?pr=owner/repo%2312.");
        if (req.method === "GET") {
          send(res, 200, await api.followUps.watch(pr));
          return;
        }
        const body = await readJsonBody(req);
        const level = body.level === null ? null : FollowUpLevelSchema.safeParse(body.level).data;
        if (level === undefined) {
          throw new ApiError(
            400,
            "Send { level: off | rereview | your-turn | every-reply }, or { level: null } for the default.",
          );
        }
        send(res, 200, await api.followUps.setWatch(pr, level));
        return;
      }
      case "GET /api/clone": {
        const repo = url.searchParams.get("repo");
        if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new ApiError(400, "Send ?repo=owner/name.");
        send(res, 200, await api.clone(repo));
        return;
      }
      case "GET /api/cli":
        send(res, 200, await api.cliStatus());
        return;
      case "POST /api/cli/install":
        send(res, 200, await api.installCli());
        return;
      case "GET /api/telemetry":
        send(res, 200, await api.telemetry());
        return;
      case "PUT /api/telemetry": {
        const body = await readJsonBody(req);
        if (typeof body.on !== "boolean") throw new ApiError(400, "Send { on: true | false }.");
        send(res, 200, await api.setTelemetry(body.on));
        return;
      }
      case "GET /api/drafts": {
        const pr = url.searchParams.get("pr");
        if (!pr) throw new ApiError(400, "Send ?pr=owner/repo%2312.");
        send(res, 200, await api.drafts(pr));
        return;
      }
      case "GET /api/threads": {
        const pr = url.searchParams.get("pr")?.trim();
        if (!pr) throw new ApiError(400, "Send ?pr=owner/repo%2312.");
        // Comments in threads are other people's text: `send` strips control sequences from every string.
        send(res, 200, await api.threads(pr, url.searchParams.get("refresh") === "1"));
        return;
      }
      case "GET /api/diff": {
        const pr = url.searchParams.get("pr")?.trim();
        const since = url.searchParams.get("since")?.trim() || undefined;
        if (since !== undefined && (!pr || !COMMIT_SHA.test(since))) {
          throw new ApiError(400, "Send ?pr=owner/repo%2312&since=<commit sha>.");
        }
        // Paths and lines are the PR author's text: `send` strips control sequences from every string.
        send(res, 200, await api.diff(pr || undefined, since));
        return;
      }
      case "POST /api/drafts": {
        const body = await readJsonBody(req);
        const { suggestion } = suggestionFrom(body, false);
        const reply = replyFrom(body);
        if (reply) {
          if (typeof body.pr !== "string" || (body.body !== undefined && typeof body.body !== "string")) {
            throw new ApiError(400, "Send { pr, inReplyTo, body, resolve? }: a reply in a review thread.");
          }
          send(
            res,
            200,
            await api.addDraft(
              {
                pr: body.pr,
                body: typeof body.body === "string" ? body.body : "",
                ...placeFrom(body),
                ...(typeof suggestion === "string" ? { suggestion } : {}),
                ...reply,
                ...assistedFrom(body),
              },
              "you",
            ),
          );
          return;
        }
        if (
          typeof body.pr !== "string" ||
          (typeof body.body !== "string" && !(body.body === undefined && suggestion !== undefined))
        ) {
          throw new ApiError(
            400,
            "Send { pr, body }, and { path, line?, side?, startLine?, suggestion? } for a comment on code.",
          );
        }
        // Always yours: only Claude Code (through `alden mcp`) drafts as "claude".
        send(
          res,
          200,
          await api.addDraft(
            {
              pr: body.pr,
              body: typeof body.body === "string" ? body.body : "",
              ...placeFrom(body),
              ...(typeof suggestion === "string" ? { suggestion } : {}),
              ...assistedFrom(body),
            },
            "you",
          ),
        );
        return;
      }
      case "POST /api/drafts/alden": {
        const body = await readJsonBody(req);
        if (typeof body.pr !== "string" || !body.pr.trim()) {
          throw new ApiError(400, "Send { pr: owner/repo#12, tone? }.");
        }
        const tone = toneFrom(body);
        send(res, 200, await api.draftReview({ pr: body.pr.trim(), ...(tone ? { tone } : {}) }));
        return;
      }
      case "GET /api/tone": {
        const repo = url.searchParams.get("repo")?.trim() || undefined;
        if (repo !== undefined && !REPO_NAME.test(repo)) throw new ApiError(400, "Send ?repo=owner/name, or no repo.");
        send(res, 200, await api.tone(repo));
        return;
      }
      case "PUT /api/tone": {
        const body = await readJsonBody(req, 1024);
        const usage = `Send { repo?: owner/name, tone: ${DraftToneSchema.options.join(" | ")} }, or { repo, tone: null } to use the default there.`;
        const repo = body.repo;
        if (repo !== undefined && (typeof repo !== "string" || !REPO_NAME.test(repo.trim()))) {
          throw new ApiError(400, usage);
        }
        const tone = body.tone === null && typeof repo === "string" ? null : DraftToneSchema.safeParse(body.tone).data;
        if (tone === undefined) throw new ApiError(400, usage);
        send(res, 200, await api.setTone({ ...(typeof repo === "string" ? { repo: repo.trim() } : {}), tone }));
        return;
      }
      case "POST /api/ask":
        await streamAsk(await readJsonBody(req), res);
        return;
      case "POST /api/drafts/suggest-text": {
        const body = await readJsonBody(req);
        const usage =
          "Send { pr, text? } with { path, line?, side?, startLine? } for a comment on code, or { threadId } for a reply.";
        if (
          typeof body.pr !== "string" ||
          !body.pr.trim() ||
          (body.text !== undefined && typeof body.text !== "string")
        ) {
          throw new ApiError(400, usage);
        }
        const place = placeFrom(body);
        const threadId = body.threadId;
        if (threadId !== undefined && (typeof threadId !== "string" || !/^[\w=-]{1,200}$/.test(threadId) || place)) {
          throw new ApiError(400, usage);
        }
        const tone = toneFrom(body);
        // Closing the request (Cancel in the UI) stops it: before the call, nothing is asked; after, the answer is dropped.
        const stop = new AbortController();
        res.on("close", () => {
          if (!res.writableFinished) stop.abort();
        });
        send(
          res,
          200,
          await api.suggestText(
            {
              pr: body.pr.trim(),
              ...place,
              ...(typeof threadId === "string" ? { threadId } : {}),
              ...(typeof body.text === "string" ? { text: body.text.slice(0, 65_536) } : {}),
              ...(tone ? { tone } : {}),
            },
            stop.signal,
          ),
        );
        return;
      }
      case "POST /api/drafts/keep": {
        const body = await readJsonBody(req);
        const ids = Array.isArray(body.ids) ? body.ids : undefined;
        const validIds = ids?.every((id) => typeof id === "string" && /^[\w-]{1,64}$/.test(id)) && ids.length <= 100;
        if (
          (ids !== undefined && !validIds) ||
          (body.pr !== undefined && typeof body.pr !== "string") ||
          (!ids && !body.pr)
        ) {
          throw new ApiError(400, "Send { ids: [draft ids] } or { pr: owner/repo#12 } to keep Alden's drafts there.");
        }
        send(
          res,
          200,
          await api.keepDrafts({
            ...(ids ? { ids: ids as string[] } : {}),
            ...(typeof body.pr === "string" ? { pr: body.pr } : {}),
          }),
        );
        return;
      }
      case "POST /api/review/send": {
        const body = await readJsonBody(req);
        const events = ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const;
        const event = events.find((e) => e === body.event);
        if (typeof body.pr !== "string" || !event || (body.body !== undefined && typeof body.body !== "string")) {
          throw new ApiError(400, "Send { pr, event: COMMENT | APPROVE | REQUEST_CHANGES, body? }.");
        }
        send(
          res,
          200,
          await api.sendReview({ pr: body.pr, event, ...(typeof body.body === "string" ? { body: body.body } : {}) }),
        );
        return;
      }
      case "GET /api/review-time":
        send(res, 200, await api.reviewTime());
        return;
      case "POST /api/review-time": {
        const body = await readJsonBody(req, 1024);
        const { pr, activeMs } = body;
        if (
          typeof pr !== "string" ||
          !/^[\w.-]+\/[\w.-]+#\d{1,9}$/.test(pr) ||
          typeof activeMs !== "number" ||
          !Number.isFinite(activeMs) ||
          activeMs <= 0 ||
          activeMs > MAX_ACTIVE_REPORT_MS
        ) {
          throw new ApiError(400, `Send { pr: owner/repo#12, activeMs } with activeMs up to ${MAX_ACTIVE_REPORT_MS}.`);
        }
        send(res, 200, await api.reportActive({ pr, activeMs }));
        return;
      }
      case "POST /api/seen":
        send(res, 200, await api.recordSeen(seenFrom(await readJsonBody(req, MAX_SEEN_BYTES))));
        return;
      case "POST /api/briefing/markdown": {
        const briefing = await briefingFrom(req);
        send(res, 200, { markdown: briefingMarkdown(briefing), fileName: briefingFileName(briefing) });
        return;
      }
      case "POST /api/briefing/save":
        send(res, 200, await api.saveBriefing(await briefingFrom(req)));
        return;
      case "GET /api/feedback/export":
        send(res, 200, await api.exportFeedback());
        return;
      case "POST /api/open": {
        const body = await readJsonBody(req);
        send(res, 200, await api.openLink(webLink(body.url)));
        return;
      }
      case "POST /api/feedback/save":
        send(res, 200, await api.saveFeedback());
        return;
      case "POST /api/memory/forget": {
        const body = await readJsonBody(req);
        if (typeof body.id !== "string") throw new ApiError(400, "Send { id }, and optionally { repo }.");
        send(
          res,
          200,
          await api.forgetMemory({ id: body.id, ...(typeof body.repo === "string" ? { repo: body.repo } : {}) }),
        );
        return;
      }
      default:
        send(res, 404, { error: `No such endpoint: ${key}` });
    }
  }

  /** Newline-delimited JSON: stage events as the review goes, then the briefing or an error. */
  async function streamReview(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const request: ReviewRequest = {
      ...(typeof body.pr === "string" && body.pr.trim() ? { pr: body.pr.trim() } : {}),
      ...(typeof body.llm === "boolean" ? { llm: body.llm } : {}),
      ...(typeof body.graph === "boolean" ? { graph: body.graph } : {}),
      ...(typeof body.model === "string" && body.model ? { model: body.model } : {}),
      ...(typeof body.effort === "string" && body.effort ? { effort: body.effort } : {}),
    };
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/x-ndjson; charset=utf-8" });
    const write = (event: ReviewEvent) => res.write(`${JSON.stringify(stripControlDeep(event))}\n`);
    try {
      const briefing = await options.api.review(request, (stage, label) => write({ type: "stage", stage, label }));
      write({ type: "briefing", briefing });
    } catch (error) {
      write({ type: "error", message: (error as Error).message });
    }
    res.end();
  }

  /**
   * Newline-delimited JSON: the answer to a question about a PR as it's written ({ type: "delta", text }), then
   * { type: "done", costUsd, model } or { type: "error", message, status }. Closing the request stops the model call.
   */
  async function streamAsk(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const { pr, question, model } = body;
    if (
      typeof pr !== "string" ||
      !pr.trim() ||
      typeof question !== "string" ||
      !question.trim() ||
      question.length > MAX_QUESTION_CHARS ||
      (model !== undefined && (typeof model !== "string" || !model.trim()))
    ) {
      throw new ApiError(400, `Send { pr: owner/repo#12, question (up to ${MAX_QUESTION_CHARS} characters), model? }.`);
    }
    const stop = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) stop.abort();
    });
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/x-ndjson; charset=utf-8" });
    // The answer can quote the PR: `stripControlDeep` takes out control sequences, as for every other string.
    const write = (event: AskEvent) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(stripControlDeep(event))}\n`);
    };
    try {
      const done = await options.api.ask(
        { pr: pr.trim(), question: question.trim(), ...(typeof model === "string" ? { model: model.trim() } : {}) },
        (text) => write({ type: "delta", text }),
        stop.signal,
      );
      write({ type: "done", ...done });
    } catch (error) {
      write({
        type: "error",
        message: (error as Error).message,
        status: error instanceof ApiError ? error.status : 500,
      });
    }
    res.end();
  }

  /**
   * Newline-delimited JSON, like a review: Ollama's pull progress, then done or an error. Closing the request (the
   * dialog closed) stops the download.
   */
  async function streamLocalSetup(model: string, res: ServerResponse): Promise<void> {
    const stop = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) stop.abort();
    });
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/x-ndjson; charset=utf-8" });
    const write = (event: LocalSetupEvent) => res.write(`${JSON.stringify(stripControlDeep(event))}\n`);
    try {
      await options.api.modelSetup.useLocal(model, write, stop.signal);
    } catch (error) {
      write({ type: "error", message: (error as Error).message });
    }
    res.end();
  }

  /** The built UI's files: in memory for a standalone binary, or from the UI directory. */
  async function readUiFile(relative: string): Promise<Uint8Array | undefined> {
    if (options.files) return options.files.get(relative);
    const dir = options.staticDir;
    if (!dir) return undefined;
    const file = join(dir, relative);
    // Only files inside the UI directory.
    if (!file.startsWith(dir + sep)) return undefined;
    try {
      return await readFile(file);
    } catch {
      return undefined;
    }
  }

  async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const index = await readUiFile("index.html");
    if (!index) {
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><meta charset=utf-8><title>Alden</title><p>The Alden UI isn't built. Run <code>pnpm --filter @alden/ui build</code>, then <code>pnpm build</code>.</p>",
      );
      return;
    }
    // Anything that isn't a file is the app (it routes on the client).
    const relative = normalize(decodeURIComponent(pathname))
      .replace(/^([/\\])+/, "")
      .split(sep)
      .join("/");
    const asset = !relative.startsWith("..") && extname(relative) ? await readUiFile(relative) : undefined;
    const name = asset ? relative : "index.html";
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": TYPES[extname(name)] ?? "application/octet-stream",
      ...(name.startsWith("assets/") ? { "Cache-Control": "public, max-age=31536000, immutable" } : {}),
    });
    res.end(asset ?? index);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  return {
    server,
    port,
    token,
    url: `http://127.0.0.1:${port}/#t=${token}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
