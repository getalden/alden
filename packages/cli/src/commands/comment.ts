import { createInterface } from "node:readline/promises";
import { composeReviewBody, JsonCache } from "@alden/core";
import type { ReviewDraft, ReviewEvent, UnaddressedPlace } from "@alden/schema";
import type { Command } from "commander";
import { parsePrRef, queuePick } from "../pr-ref.js";
import { paint, shouldColor, stripControlDeep } from "../render/style.js";
import { createUiApi } from "../ui/api.js";
import { originOf } from "./memory.js";
import { LAST_QUEUE_KEY, type LastQueue } from "./open.js";

/** `src/pay.ts:12` → a file and line; anything else isn't a place. */
export function parseWhere(text: string): { path: string; line: number } | undefined {
  const match = /^(\S+):(\d+)$/.exec(text.trim());
  if (!match || Number(match[2]) < 1) return undefined;
  return { path: match[1] as string, line: Number(match[2]) };
}

const placeOf = (d: ReviewDraft) =>
  d.path === undefined ? "general note" : `${d.path}:${d.line}${d.side === "LEFT" ? " (old side)" : ""}`;
const indent = (text: string, by: string) =>
  text
    .split("\n")
    .map((l) => (l ? `${by}${l}` : l))
    .join("\n");

/** A PR's drafts, as `alden comment <pr>` lists them. Text from drafts is shown, never run: escape codes are removed. */
export function renderDrafts(pr: string, untrusted: ReviewDraft[], color: boolean): string {
  const drafts = stripControlDeep(untrusted);
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
    out.push(`  ${paint(d.id, "dim", color)}  ${placeOf(d)}${paint(who, "dim", color)}`);
    if (d.state === "outdated") {
      out.push(
        paint(
          "    outdated: the PR moved on and this line changed or left the diff; it can't be sent",
          "yellow",
          color,
        ),
      );
    }
    out.push(indent(d.body, "    "), "");
  }
  if (outdated > 0) {
    out.push(
      `Delete an outdated comment (alden comment ${pr} --delete <id>) and write it again where it belongs, or place it again in alden ui.`,
    );
  }
  out.push(`Send them as one review: alden send ${pr} --comment | --approve | --request-changes`);
  return `${out.join("\n")}\n`;
}

const VERDICT_NAMES: Record<ReviewEvent, string> = {
  COMMENT: "Comment",
  APPROVE: "Approve",
  REQUEST_CHANGES: "Request changes",
};

/** Everything `alden send` will post, exactly, before it asks. */
export function renderSendSummary(
  input: { pr: string; event: ReviewEvent; body?: string; drafts: ReviewDraft[]; unaddressed: UnaddressedPlace[] },
  color: boolean,
): string {
  const { drafts, unaddressed, body } = stripControlDeep(input);
  const text = composeReviewBody(body, drafts);
  const inline = drafts.filter((d) => d.path !== undefined);
  const fromClaude = drafts.filter((d) => d.source === "claude").length;
  const out = [paint(`Review for ${input.pr}: ${VERDICT_NAMES[input.event]}`, "bold", color), ""];
  out.push(paint("Body", "bold", color), text ? indent(text, "  ") : paint("  (none)", "dim", color), "");
  out.push(paint(`Comments (${inline.length})`, "bold", color));
  if (inline.length === 0) out.push(paint("  (none)", "dim", color));
  for (const d of inline) {
    out.push(`  ${placeOf(d)}${d.source === "claude" ? paint(" · drafted by Claude Code", "dim", color) : ""}`);
    out.push(indent(d.body, "    "));
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

export function registerCommentCommands(program: Command, version: string): void {
  const api = () => createUiApi({ version, cwd: process.cwd() });
  const fail = (error: unknown): never => program.error((error as Error).message);

  program
    .command("comment")
    .description(
      "Write a comment on a PR, kept in Alden until you send it: on a line (file:line) or, without one, a general note. With no text, list the PR's comments.",
    )
    .argument("<pr>", "a PR URL, owner/repo#123, or a # from `alden queue`")
    .argument("[text...]", 'where and what: src/pay.ts:12 "Is this in cents?", or just the text for a general note')
    .option("--left", "the line number is in the old file (a removed line)")
    .option("--delete <id>", "delete a comment instead")
    .option("--json", "print the comments as JSON")
    .action(async (prArg: string, words: string[], options: { left?: boolean; delete?: string; json?: boolean }) => {
      const pr = await prFrom(program, prArg, "alden comment");
      const color = shouldColor(process.stdout);
      if (options.delete) {
        await api().deleteDraft(options.delete).catch(fail);
        console.log(`Deleted ${options.delete}.`);
        return;
      }
      if (words.length === 0) {
        const { drafts, unaddressed } = await api().drafts(pr).catch(fail);
        if (options.json) console.log(JSON.stringify({ drafts, unaddressed }, null, 2));
        else process.stdout.write(renderDrafts(pr, drafts, color));
        return;
      }
      const where = parseWhere(words[0] as string);
      const text = (where ? words.slice(1) : words).join(" ");
      if (where && !text.trim())
        program.error(`Add the comment's text: alden comment ${pr} ${words[0]} "Your comment"`);
      const draft = await api()
        .addDraft({
          pr,
          body: text,
          ...(where ? { ...where, ...(options.left ? { side: "LEFT" as const } : {}) } : {}),
        })
        .catch(fail);
      if (options.json) {
        console.log(JSON.stringify(draft, null, 2));
        return;
      }
      console.log(`Drafted ${draft.id} (${placeOf(draft)}) for ${pr}. Nothing is posted until you send it:`);
      console.log(paint(`  alden send ${pr} --comment | --approve | --request-changes`, "dim", color));
    });

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
        const outdated = drafts.filter((d) => d.state === "outdated");
        if (outdated.length > 0) {
          process.stdout.write(renderDrafts(pr, drafts, color));
          program.error(
            `Not sent: ${outdated.map((d) => d.id).join(", ")} can't be sent until placed again or deleted.`,
          );
        }
        process.stdout.write(
          renderSendSummary(
            { pr, event, ...(options.message !== undefined ? { body: options.message } : {}), drafts, unaddressed },
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
        console.log(`Sent: ${sent.url} (${sent.posted} comment${sent.posted === 1 ? "" : "s"}).`);
      },
    );
}
