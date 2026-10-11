import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { composeReviewBody, findThread, JsonCache, shortThreadId, threadWhere } from "@alden/core";
import type { ReviewDraft, ReviewEvent, ReviewThread, SendReviewResult, UnaddressedPlace } from "@alden/schema";
import type { Command } from "commander";
import { parsePrRef, queuePick } from "../pr-ref.js";
import { paint, shouldColor, stripControlDeep } from "../render/style.js";
import { createUiApi } from "../ui/api.js";
import { originOf } from "./memory.js";
import { LAST_QUEUE_KEY, type LastQueue } from "./open.js";

/**
 * `src/pay.ts:12` → a file and line; `src/pay.ts:12-14` → a file and the lines from 12 to 14 (the last is `line`);
 * anything else isn't a place. A range the wrong way round is kept as typed, for the engine to say so.
 */
export function parseWhere(text: string): { path: string; line: number; startLine?: number } | undefined {
  const match = /^(\S+):(\d+)(?:-(\d+))?$/.exec(text.trim());
  if (!match || Number(match[2]) < 1 || (match[3] !== undefined && Number(match[3]) < 1)) return undefined;
  const first = Number(match[2]);
  const last = match[3] === undefined ? first : Number(match[3]);
  return { path: match[1] as string, line: last, ...(last !== first ? { startLine: first } : {}) };
}

const lines = (d: { line?: number | undefined; startLine?: number | undefined }) =>
  d.line === undefined ? "" : `:${d.startLine !== undefined ? `${d.startLine}-` : ""}${d.line}`;

/** "reply in thread on src/pay.ts:40, and resolve it": where a reply posts, by its thread when it's known. */
export function replyPlace(d: ReviewDraft, threads: ReviewThread[] = []): string {
  const thread = threads.find((t) => t.id === d.inReplyTo);
  const where = thread ? `thread on ${threadWhere(thread)}` : `thread ${shortThreadId(d.inReplyTo ?? "")}`;
  if (d.body.trim() === "") return `resolve the ${where}`;
  return `reply in ${where}${d.resolve ? ", and resolve it" : ""}`;
}

const placeOf = (d: ReviewDraft, threads: ReviewThread[] = []) =>
  d.inReplyTo !== undefined
    ? replyPlace(d, threads)
    : d.path === undefined
      ? d.linkTo
        ? `general note, linking to ${d.linkTo.path}${lines(d.linkTo)}`
        : "general note"
      : `${d.path}${lines(d)}${d.side === "LEFT" ? " (old side)" : ""}`;
const indent = (text: string, by: string) =>
  text
    .split("\n")
    .map((l) => (l ? `${by}${l}` : l))
    .join("\n");

/** A suggested change as lines: the code it replaces (-) and the code it suggests (+), or that it deletes them. */
export function renderSuggestion(d: ReviewDraft, color: boolean, by = "    "): string[] {
  if (d.suggestion === undefined) return [];
  const on = d.linkTo ?? d;
  const lines =
    d.originalLines?.length ?? (on.startLine !== undefined && on.line !== undefined ? on.line - on.startLine + 1 : 1);
  const out = [
    paint(
      `${by}suggested change: ${d.suggestion === "" ? `delete ${lines === 1 ? "this line" : `these ${lines} lines`}` : `replace ${lines === 1 ? "this line" : `these ${lines} lines`}`}`,
      "dim",
      color,
    ),
  ];
  for (const old of d.originalLines ?? []) out.push(paint(`${by}- ${old}`, "red", color));
  if (d.suggestion !== "")
    for (const line of d.suggestion.split("\n")) out.push(paint(`${by}+ ${line}`, "green", color));
  return out;
}

/** A comment's text and its suggestion, as listed. */
const renderComment = (d: ReviewDraft, color: boolean): string[] => [
  ...(d.body.trim() ? [indent(d.body, "    ")] : []),
  ...renderSuggestion(d, color),
];

/**
 * A PR's drafts, as `alden comment <pr>` lists them; a reply says which thread it's in when `threads` has it. Text from
 * drafts is shown, never run: escape codes are removed.
 */
export function renderDrafts(
  pr: string,
  untrusted: ReviewDraft[],
  color: boolean,
  untrustedThreads: ReviewThread[] = [],
): string {
  const drafts = stripControlDeep(untrusted);
  const threads = stripControlDeep(untrustedThreads);
  if (drafts.length === 0) {
    return `No comments waiting for ${pr}.\nWrite one: alden comment ${pr} src/file.ts:12 "Your comment"\n`;
  }
  const outdated = drafts.filter((d) => d.state === "outdated").length;
  const out = [
    paint(`${pr}: ${drafts.length} comment${drafts.length === 1 ? "" : "s"} waiting to be sent`, "bold", color),
    "",
  ];
  for (const d of drafts) {
    const who = d.source === "claude" ? " · drafted by Claude Code" : "";
    out.push(`  ${paint(d.id, "dim", color)}  ${placeOf(d, threads)}${paint(who, "dim", color)}`);
    if (d.state === "outdated") {
      out.push(
        paint(
          "    outdated: the PR moved on and this line changed or left the diff; it can't be sent",
          "yellow",
          color,
        ),
      );
    }
    out.push(...renderComment(d, color), "");
  }
  if (outdated > 0) {
    out.push(
      `Delete an outdated comment (alden comment ${pr} --delete <id>) and write it again where it belongs, or place it again in alden ui.`,
    );
  }
  out.push(`Send them as one review: alden send ${pr} --comment | --approve | --request-changes`);
  return `${out.join("\n")}\n`;
}

/** What `alden comment` says once a comment is drafted: where it went (a linked note says why), and how to send. */
export function draftedLines(untrusted: ReviewDraft, pr: string): string[] {
  const draft = stripControlDeep(untrusted);
  const kind = draft.suggestion !== undefined ? ", a suggested change" : "";
  const out: string[] = [];
  if (draft.linkTo) {
    const suggested =
      draft.suggestion !== undefined ? " GitHub can't apply a suggestion from there: it posts as code to copy." : "";
    out.push(
      `${draft.linkTo.path}${lines(draft.linkTo)} isn't in the PR's diff, so this goes in the review body with a link to it, at the PR's head now (${draft.headSha.slice(0, 7)}).${suggested}`,
    );
  }
  out.push(`Drafted ${draft.id} (${placeOf(draft)}${kind}) for ${pr}. Nothing is posted until you send it:`);
  return out;
}

const VERDICT_NAMES: Record<ReviewEvent, string> = {
  COMMENT: "Comment",
  APPROVE: "Approve",
  REQUEST_CHANGES: "Request changes",
};

/** Everything `alden send` will post, exactly, before it asks. */
export function renderSendSummary(
  input: {
    pr: string;
    event: ReviewEvent;
    body?: string;
    drafts: ReviewDraft[];
    unaddressed: UnaddressedPlace[];
    /** The PR's threads, to say where each reply goes. */
    threads?: ReviewThread[];
  },
  color: boolean,
): string {
  const { drafts, unaddressed, body, threads } = stripControlDeep(input);
  const text = composeReviewBody(body, drafts);
  const inline = drafts.filter((d) => d.path !== undefined);
  const replies = drafts.filter((d) => d.inReplyTo !== undefined);
  const fromClaude = drafts.filter((d) => d.source === "claude").length;
  const out = [paint(`Review for ${input.pr}: ${VERDICT_NAMES[input.event]}`, "bold", color), ""];
  out.push(paint("Body", "bold", color), text ? indent(text, "  ") : paint("  (none)", "dim", color), "");
  out.push(paint(`Comments (${inline.length})`, "bold", color));
  if (inline.length === 0) out.push(paint("  (none)", "dim", color));
  for (const d of inline) {
    out.push(`  ${placeOf(d)}${d.source === "claude" ? paint(" · drafted by Claude Code", "dim", color) : ""}`);
    out.push(...renderComment(d, color));
  }
  out.push(...renderReplies(replies, threads ?? [], color));
  const suggestions = inline.filter((d) => d.suggestion !== undefined).length;
  if (suggestions > 0) {
    out.push(
      "",
      paint(
        `${suggestions === 1 ? "The suggested change posts as a GitHub suggestion" : `The ${suggestions} suggested changes post as GitHub suggestions`}: the author can apply ${suggestions === 1 ? "it" : "them"} with a click.`,
        "dim",
        color,
      ),
    );
  }
  if (fromClaude > 0) {
    out.push(
      "",
      paint(
        `${fromClaude} of these ${fromClaude === 1 ? "was" : "were"} drafted by Claude Code: they post as you.`,
        "yellow",
        color,
      ),
    );
  }
  if (input.event === "APPROVE" && unaddressed.length > 0) {
    out.push("", paint("Places Alden flagged that you didn't comment on", "bold", color));
    for (const place of unaddressed) {
      const where = place.path ? ` (${place.path}${place.line ? `:${place.line}` : ""})` : "";
      out.push(`  ${paint("!", "yellow", color)} ${place.title}${paint(where, "dim", color)}`);
    }
  }
  return `${out.join("\n")}\n`;
}

/** The summary's replies: each in its thread, and the threads resolved once the review is submitted. */
function renderReplies(replies: ReviewDraft[], threads: ReviewThread[], color: boolean): string[] {
  if (replies.length === 0) return [];
  const out = ["", paint(`Replies in threads (${replies.length})`, "bold", color)];
  for (const d of replies) {
    const head = replyPlace(d, threads);
    out.push(
      `  ${head[0]?.toUpperCase()}${head.slice(1)}${d.source === "claude" ? paint(" · drafted by Claude Code", "dim", color) : ""}`,
    );
    if (d.body.trim()) out.push(indent(d.body, "    "));
  }
  if (replies.some((d) => d.resolve)) {
    out.push(paint("Threads are resolved after the review is submitted, never before.", "dim", color));
  }
  return out;
}

/** "Sent: <url> (2 comments, 1 reply; 1 thread resolved)", then any thread GitHub wouldn't resolve. */
export function sentLines(sent: SendReviewResult, color: boolean): string[] {
  const replies = sent.replies ?? 0;
  const comments = sent.posted - replies;
  const parts = [
    ...(comments > 0 || replies === 0 ? [`${comments} comment${comments === 1 ? "" : "s"}`] : []),
    ...(replies > 0 ? [`${replies} repl${replies === 1 ? "y" : "ies"}`] : []),
  ];
  const threads = sent.resolved ? `${sent.resolved} thread${sent.resolved === 1 ? "" : "s"} resolved` : "";
  // Only resolves: no review was posted, so there's nothing to count but them.
  const what = sent.posted === 0 && threads ? threads : `${parts.join(", ")}${threads ? `; ${threads}` : ""}`;
  return [
    `Sent: ${sent.url} (${what}).`,
    ...(sent.notResolved ?? []).map((line) =>
      paint(`Not resolved (the review did post): ${stripControlDeep(line)}`, "yellow", color),
    ),
  ];
}

/** Threads yours first (started or replied in), then open before resolved, then by file and line. */
export function sortThreads(threads: ReviewThread[]): ReviewThread[] {
  const yours = (t: ReviewThread) => t.startedByYou || t.comments.some((c) => c.isYou);
  return [...threads].sort(
    (a, b) =>
      Number(yours(b)) - Number(yours(a)) ||
      Number(a.isResolved) - Number(b.isResolved) ||
      a.path.localeCompare(b.path) ||
      (a.line ?? a.originalLine ?? 0) - (b.line ?? b.originalLine ?? 0),
  );
}

/** A PR's review threads, as `alden comment <pr> --threads` lists them: a short id to reply by, and every comment. */
export function renderThreads(pr: string, untrusted: ReviewThread[], color: boolean): string {
  const threads = sortThreads(stripControlDeep(untrusted));
  if (threads.length === 0) return `${pr} has no review threads yet.\n`;
  const open = threads.filter((t) => !t.isResolved).length;
  const out = [
    paint(`${pr}: ${threads.length} review thread${threads.length === 1 ? "" : "s"}, ${open} open`, "bold", color),
    "",
  ];
  for (const t of threads) {
    const state = [
      t.isResolved ? "resolved" : "open",
      ...(t.isOutdated ? ["outdated"] : []),
      ...(t.startedByYou ? ["started by you"] : []),
    ].join(" · ");
    out.push(
      `  ${paint(shortThreadId(t.id), "dim", color)}  ${threadWhere(t)}  ${paint(state, t.isResolved ? "dim" : "yellow", color)}`,
    );
    for (const c of t.comments) {
      out.push(`    ${paint(c.isYou ? "you" : (c.author ?? "(deleted account)"), "bold", color)}`);
      out.push(indent(c.body, "      "));
    }
    out.push("");
  }
  out.push(`Reply: alden comment ${pr} --reply <id or file:line> "Your reply" [--resolve]`);
  out.push(`Resolve: alden comment ${pr} --resolve <id or file:line>. Both go with your review when you send it.`);
  return `${out.join("\n")}\n`;
}

/** The PR as typed, named as drafts name it, saying which PR a queue number picked. */
async function prFrom(program: Command, input: string, command: string): Promise<string> {
  const last = await new JsonCache().get<LastQueue>(LAST_QUEUE_KEY, 24 * 3_600_000);
  try {
    const ref = parsePrRef(input, last?.urls);
    const picked = queuePick(input, ref, await originOf(), command);
    if (picked) console.error(picked);
    return `${ref.repo}#${ref.number}`;
  } catch (error) {
    program.error((error as Error).message);
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

interface CommentOptions {
  left?: boolean;
  suggest?: string;
  suggestFile?: string;
  delete?: string;
  json?: boolean;
  threads?: boolean;
  reply?: string;
  /** With --reply, a flag; alone, the thread to resolve. */
  resolve?: string | boolean;
}

/** One trailing newline off code read from a file or stdin: editors add one, and it isn't a line of the suggestion. */
const withoutFinalNewline = (code: string) => code.replace(/\r?\n$/, "");

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/** The suggestion from --suggest (as typed, or stdin for -) or --suggest-file; at most one of them. */
export async function suggestionFrom(
  options: Pick<CommentOptions, "suggest" | "suggestFile">,
  read: { stdin: () => Promise<string>; file: (path: string) => Promise<string> } = {
    stdin: readStdin,
    file: (path) => readFile(path, "utf8"),
  },
): Promise<string | undefined> {
  if (options.suggest !== undefined && options.suggestFile !== undefined) {
    throw new Error("Give the suggestion once: --suggest or --suggest-file, not both.");
  }
  if (options.suggestFile !== undefined) {
    try {
      return withoutFinalNewline(await read.file(options.suggestFile));
    } catch (error) {
      throw new Error(`Couldn't read ${options.suggestFile}: ${(error as Error).message}`);
    }
  }
  if (options.suggest === "-") {
    if (process.stdin.isTTY && read.stdin === readStdin) {
      throw new Error("--suggest - reads the code from stdin: pipe it in (pbpaste | alden comment ...).");
    }
    return withoutFinalNewline(await read.stdin());
  }
  return options.suggest;
}

export function registerCommentCommands(program: Command, version: string): void {
  const api = () => createUiApi({ version, cwd: process.cwd() });
  const fail = (error: unknown): never => program.error((error as Error).message);

  program
    .command("comment")
    .description(
      "Write a comment on a PR, kept in Alden until you send it: on a line (file:line), on lines (file:12-14), or without one a general note. A line outside the PR's diff becomes a general note linking to it. --suggest makes it a suggested change GitHub can apply. With no text, list the PR's comments.",
    )
    .argument("<pr>", "a PR URL, owner/repo#123, or a # from `alden queue`")
    .argument(
      "[text...]",
      'where and what: src/pay.ts:12 "Is this in cents?", src/pay.ts:12-14 "..." for several lines, or just the text for a general note',
    )
    .option("--left", "the line numbers are in the old file (removed lines)")
    .option("--suggest <code>", "suggest replacement code for the line(s), - to read it from stdin; empty deletes them")
    .option("--suggest-file <path>", "suggest the replacement code in this file")
    .option("--delete <id>", "delete a comment instead")
    .option("--threads", "list the PR's review threads, with ids to reply by")
    .option("--reply <thread>", "reply in a review thread (its id from --threads, or file:line) instead")
    .option(
      "--resolve [thread]",
      "resolve the thread once the review is sent: with --reply, or alone naming the thread",
    )
    .option("--json", "print the comments as JSON")
    .action(async (prArg: string, words: string[], options: CommentOptions) => {
      const pr = await prFrom(program, prArg, "alden comment");
      const color = shouldColor(process.stdout);
      if (options.delete) {
        await api().deleteDraft(options.delete).catch(fail);
        console.log(`Deleted ${options.delete}.`);
        return;
      }
      if (options.threads) {
        const { threads } = await api().threads(pr).catch(fail);
        if (options.json) console.log(JSON.stringify(sortThreads(threads), null, 2));
        else process.stdout.write(renderThreads(pr, threads, color));
        return;
      }
      if (options.reply !== undefined || typeof options.resolve === "string") {
        await replyCommand(pr, words, options, color);
        return;
      }
      if (options.resolve === true) {
        program.error(`Say which thread to resolve: alden comment ${pr} --resolve <id or file:line> (see --threads).`);
      }
      if (words.length === 0) {
        const engine = api();
        const { drafts, unaddressed } = await engine.drafts(pr).catch(fail);
        if (options.json) console.log(JSON.stringify({ drafts, unaddressed }, null, 2));
        else {
          // Name each reply's thread by where it is; without GitHub, by its id.
          const threads = drafts.some((d) => d.inReplyTo !== undefined)
            ? ((await engine.threads(pr).catch(() => undefined))?.threads ?? [])
            : [];
          process.stdout.write(renderDrafts(pr, drafts, color, threads));
        }
        return;
      }
      const suggestion = await suggestionFrom(options).catch(fail);
      const where = parseWhere(words[0] as string);
      const text = (where ? words.slice(1) : words).join(" ");
      if (suggestion !== undefined && !where) {
        program.error(
          `A suggestion replaces lines: say which, as file:line or file:12-14 (alden comment ${pr} src/file.ts:12 --suggest "...").`,
        );
      }
      if (where && !text.trim() && suggestion === undefined)
        program.error(`Add the comment's text: alden comment ${pr} ${words[0]} "Your comment"`);
      const draft = await api()
        .addDraft({
          pr,
          body: text,
          ...(where ? { ...where, ...(options.left ? { side: "LEFT" as const } : {}) } : {}),
          ...(suggestion !== undefined ? { suggestion } : {}),
        })
        .catch(fail);
      if (options.json) {
        console.log(JSON.stringify(draft, null, 2));
        return;
      }
      for (const line of draftedLines(draft, pr)) console.log(line);
      console.log(paint(`  alden send ${pr} --comment | --approve | --request-changes`, "dim", color));
    });

  /**
   * `--reply <thread> "text" [--resolve]`, or `--resolve <thread>` alone: a reply draft in that thread, or a change to
   * the one already there (one reply per thread). `--resolve` before the text would take the text as its thread, so a
   * word after a bare `--reply ... --resolve` is the reply.
   */
  async function replyCommand(pr: string, words: string[], options: CommentOptions, color: boolean): Promise<void> {
    if (options.suggest !== undefined || options.suggestFile !== undefined || options.left) {
      program.error("A reply posts in its thread: it takes no --suggest or --left.");
    }
    let target = options.reply;
    let text = words;
    let resolve = options.resolve !== undefined && options.resolve !== false;
    if (typeof options.resolve === "string") {
      if (target === undefined) target = options.resolve;
      else text = [options.resolve, ...words];
    }
    const body = text.join(" ");
    if (!body.trim() && !resolve) {
      program.error(
        `Add the reply's text: alden comment ${pr} --reply ${target} "Your reply" (and --resolve to resolve it).`,
      );
    }
    const engine = api();
    const { threads } = await engine.threads(pr).catch(fail);
    let thread: ReviewThread;
    try {
      thread = findThread(threads, target as string);
    } catch (error) {
      program.error((error as Error).message);
    }
    const existing = (await engine.drafts(pr).catch(fail)).drafts.find((d) => d.inReplyTo === thread.id);
    // A second --reply replaces the text; --resolve alone ticks Resolve on the reply that's there.
    if (existing && !body.trim()) resolve = true;
    const draft = existing
      ? await engine
          .editDraft(existing.id, { ...(body.trim() ? { body } : {}), ...(resolve ? { resolve: true } : {}) })
          .catch(fail)
      : await engine.addDraft({ pr, body, inReplyTo: thread.id, ...(resolve ? { resolve: true } : {}) }).catch(fail);
    if (options.json) {
      console.log(JSON.stringify(draft, null, 2));
      return;
    }
    console.log(
      `${existing ? "Changed" : "Drafted"} ${draft.id} (${replyPlace(draft, [thread])}) for ${pr}. Nothing is posted until you send your review:`,
    );
    console.log(paint(`  alden send ${pr} --comment | --approve | --request-changes`, "dim", color));
  }

  program
    .command("send")
    .description(
      "Send a PR's comments to GitHub as one review: comment, approve or request changes. Shows exactly what will post and asks first.",
    )
    .argument("<pr>", "a PR URL, owner/repo#123, or a # from `alden queue`")
    .option("--comment", "a review that comments, without approving")
    .option("--approve", "approve the PR")
    .option("--request-changes", "request changes")
    .option("-m, --message <body>", "the review's body (general notes are added after it)")
    .option("-y, --yes", "send without asking (otherwise it asks, and refuses where it can't ask)")
    .action(
      async (
        prArg: string,
        options: { comment?: boolean; approve?: boolean; requestChanges?: boolean; message?: string; yes?: boolean },
      ) => {
        const picked = [
          options.comment ? ("COMMENT" as const) : undefined,
          options.approve ? ("APPROVE" as const) : undefined,
          options.requestChanges ? ("REQUEST_CHANGES" as const) : undefined,
        ].filter((e) => e !== undefined);
        if (picked.length !== 1)
          program.error("Say what the review does: one of --comment, --approve or --request-changes.");
        const event = picked[0] as ReviewEvent;
        const pr = await prFrom(program, prArg, "alden send");
        const color = shouldColor(process.stdout);
        const engine = api();
        const { drafts, unaddressed } = await engine.drafts(pr).catch(fail);
        const threads = drafts.some((d) => d.inReplyTo !== undefined)
          ? ((await engine.threads(pr).catch(() => undefined))?.threads ?? [])
          : [];
        const outdated = drafts.filter((d) => d.state === "outdated");
        if (outdated.length > 0) {
          process.stdout.write(renderDrafts(pr, drafts, color));
          program.error(
            `Not sent: ${outdated.map((d) => d.id).join(", ")} can't be sent until placed again or deleted.`,
          );
        }
        process.stdout.write(
          renderSendSummary(
            {
              pr,
              event,
              ...(options.message !== undefined ? { body: options.message } : {}),
              drafts,
              unaddressed,
              threads,
            },
            color,
          ),
        );
        if (!options.yes) {
          if (!process.stdin.isTTY || !process.stdout.isTTY) {
            program.error("Not sent: there's no terminal to ask you on. Add --yes to send it as shown.");
          }
          if (!(await confirm("\nSend this review to GitHub? [y/N] "))) {
            console.log("Not sent. Your comments are still here.");
            return;
          }
        }
        const sent = await engine
          .sendReview({ pr, event, ...(options.message !== undefined ? { body: options.message } : {}) })
          .catch(fail);
        for (const line of sentLines(sent, color)) console.log(line);
        // What the review taught Alden, so learning from it is never invisible.
        for (const line of sent.learning ?? []) console.log(paint(line, "dim", color));
      },
    );
}
