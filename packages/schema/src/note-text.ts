import type { DraftLink, ReviewDraft } from "./review.js";

/**
 * How a general note reads in the review body, and the link a linked note starts with: the same text on the server
 * (what posts) and in the web UI (what the send summary shows).
 *
 * No zod here: the web UI imports this file on its own (`@alden/schema/note-text`) and shouldn't bundle a validator.
 */

/**
 * The fence for a block of code: three backticks, or one more than the longest run of backticks in the code, so
 * nothing in it can close the block early.
 */
export function codeFence(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** "owner/repo" from a draft's PR, "owner/repo#123". */
export const repoOfPr = (pr: string) => pr.replace(/#\d+$/, "");

/**
 * A file on GitHub at a commit, at a line (`#L5`) or lines (`#L5-L9`), or the whole file:
 * `https://github.com/owner/repo/blob/<sha>/path#L5`.
 */
export function lineLink(repo: string, sha: string, link: DraftLink): string {
  const path = link.path.split("/").map(encodeURIComponent).join("/");
  const range = link.startLine !== undefined && link.line !== undefined && link.startLine < link.line;
  const fragment = link.line === undefined ? "" : range ? `#L${link.startLine}-L${link.line}` : `#L${link.line}`;
  return `https://github.com/${repo}/blob/${sha}/${path}${fragment}`;
}

/** "line 5", "lines 5–9", or "" for a whole file. */
export function linkLines(link: DraftLink): string {
  if (link.line === undefined) return "";
  return link.startLine !== undefined && link.startLine < link.line
    ? `lines ${link.startLine}–${link.line}`
    : `line ${link.line}`;
}

/** Markdown that starts a block (a heading, list, quote, fence, table or rule): it can't follow "label: " on a line. */
const BLOCK_START = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|`{3,}|~{3,}|\||-{3,}|\*{3,}|_{3,})/;

/**
 * A general note as it posts in the review body. A plain note is its text. A linked note starts with a bold link to
 * the code it's about, at the head it was written against, then the text exactly as written:
 *
 *     **[`py/orders/tasks.py` line 5](https://github.com/acme/shop/blob/<sha>/py/orders/tasks.py#L5)**: Retry here too?
 *
 * Text that starts with a block (a list, a fence) goes on the next paragraph instead, so it still renders. A suggested
 * change can't be applied from the review body, so it follows as a code block headed "Suggested change", for the
 * author to copy (or "Suggested change: delete this line." when it's empty).
 */
export function noteText(draft: Pick<ReviewDraft, "pr" | "headSha" | "body" | "suggestion" | "linkTo">): string {
  const text = draft.body.trim();
  if (!draft.linkTo) return text;
  const { linkTo } = draft;
  const lines = linkLines(linkTo);
  const code = /`/.test(linkTo.path) ? linkTo.path : `\`${linkTo.path}\``;
  const label = `**[${code}${lines ? ` ${lines}` : ""}](${lineLink(repoOfPr(draft.pr), draft.headSha, linkTo)})**`;
  const head = !text ? label : BLOCK_START.test(text) ? `${label}\n\n${text}` : `${label}: ${text}`;
  if (draft.suggestion === undefined) return head;
  const many = linkTo.startLine !== undefined && linkTo.line !== undefined && linkTo.startLine < linkTo.line;
  if (draft.suggestion === "") return `${head}\n\nSuggested change: delete ${many ? "these lines" : "this line"}.`;
  const fence = codeFence(draft.suggestion);
  return `${head}\n\nSuggested change:\n\n${fence}\n${draft.suggestion}\n${fence}`;
}
