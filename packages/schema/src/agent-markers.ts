/**
 * The marks AI coding agents leave on a PR a person opened: a line in the PR's description, or a trailer in its last
 * commit's message. They find the agent PRs that `authors.ts` can't see from the author's account or the branch name,
 * e.g. a PR someone opened from their own branch after working with Claude Code. Pure, so the web UI can use it too.
 *
 * Kept conservative on purpose: a PR that talks about Claude, or quotes one of these markers in a code block, is not an
 * agent PR. Only these count:
 * - a whole line that is an agent's footer ("🤖 Generated with [Claude Code](…)"), outside code blocks and inline code;
 * - a link to an agent's task or session, with its id (`https://app.devin.ai/sessions/<id>`);
 * - an HTML comment an agent writes (`<!-- START COPILOT CODING AGENT … -->`);
 * - a `Co-authored-by:` (or Cursor's `Made-with:`) trailer at the start of a line of the commit message, naming an
 *   agent's email or its GitHub app's noreply address. A trailer's name alone ("Co-authored-by: Claude <sam@…>") never
 *   counts: only the address does.
 *
 * Where each marker comes from (checked October 2026; tools change their footers, so re-check when adding one):
 * - Claude Code: PR descriptions end "🤖 Generated with [Claude Code](https://claude.com/claude-code)" (older versions
 *   linked https://claude.ai/code), and commits carry "Co-Authored-By: Claude <model> <noreply@anthropic.com>". Both
 *   are the defaults of its `attribution.pr` and `attribution.commit` settings (formerly `includeCoAuthoredBy`):
 *   https://docs.anthropic.com/en/docs/claude-code/settings. The Claude GitHub app commits as `claude[bot]`.
 * - GitHub Copilot coding agent: commits co-authored by `Copilot <NNN+Copilot@users.noreply.github.com>` (GitHub's
 *   reserved Copilot account; more than one id is seen in the wild, e.g. 198982749 and 223556219), and the PR
 *   description carries `<!-- START COPILOT CODING AGENT SUFFIX -->` / `TIPS` comments. Its PRs are usually opened by
 *   the Copilot account itself, which `authors.ts` already knows.
 * - Cursor: cloud and background agents add "Co-authored-by: Cursor Agent <cursoragent@cursor.com>"; the IDE and CLI
 *   agents add a "Made-with: Cursor" trailer (Settings → Agents → Attribution). Per Cursor staff on
 *   https://forum.cursor.com/t/co-author-added-without-consent-and-cant-be-turned-off/150096. Background agents' PRs
 *   link "Open in Cursor" to https://cursor.com/background-agent?bcId=bc-….
 * - Devin: PR descriptions link the session ("Link to Devin run: https://app.devin.ai/sessions/<id>", plus "Requested
 *   by"); see https://cognition.ai/blog/dec-24-product-update. Its commits are by `devin-ai-integration[bot]`.
 * - Codex (cloud): PR descriptions end with a link to the task, https://chatgpt.com/codex/tasks/task_…. The Codex
 *   GitHub app is `chatgpt-codex-connector[bot]`.
 * - Jules: PR descriptions start "PR created automatically by Jules for task [N](https://jules.google.com/task/N)";
 *   commits are by `google-labs-jules[bot]`.
 * - Amazon Q Developer, Sweep and any other agent app in `AI_AGENT_LOGINS`: a co-author at the app's noreply address,
 *   `NNN+amazon-q-developer[bot]@users.noreply.github.com`, the address GitHub gives every app's bot account.
 * - OpenHands: "Co-authored-by: openhands <openhands@all-hands.dev>".
 * - Aider: "Co-authored-by: aider (<model>) <noreply@aider.chat>" with `--attribute-co-authored-by`.
 *
 * Add a marker here with its source, and to docs/queue.md ("Bots and AI agents").
 */

import { AI_AGENT_LOGINS } from "./authors.js";

/** Where Alden found an agent's marker on a PR. */
export type AgentMarkerSource = "description" | "commit";

export interface AgentMarker {
  /** The agent's slug, as `authors.ts` names it ("claude", "copilot"). */
  agent: string;
  in: AgentMarkerSource;
}

/** Lines in a PR description (or commit message) that mark an agent's work, each tried against the whole line. */
const FOOTER_LINES: { agent: string; line: RegExp }[] = [
  // "🤖 Generated with [Claude Code](https://claude.com/claude-code)", "Generated with Claude Code", in bold or not.
  { agent: "claude", line: /^[\s*_>]*(?:🤖\s*)?Generated with \[?Claude Code\]?(?:\([^)\s]*\))?[\s*_.]*$/i },
  // "*PR created automatically by Jules for task [123](https://jules.google.com/task/123) started by @sam*"
  { agent: "jules", line: /^[\s*_>]*PR created automatically by Jules for task\b/i },
];

/** Links to an agent's run, with the run's id: specific enough that only the agent's own footer has them. */
const RUN_LINKS: { agent: string; link: RegExp }[] = [
  { agent: "devin", link: /https:\/\/app\.devin\.ai\/sessions\/[0-9a-f]{8,}/i },
  { agent: "codex", link: /https:\/\/chatgpt\.com\/codex\/tasks\/task_[\w-]+/i },
  { agent: "cursor", link: /https:\/\/cursor\.com\/background-agent\?bcId=bc-[\w-]+/i },
  { agent: "jules", link: /https:\/\/jules\.google\.com\/task\/\d+/i },
];

/** HTML comments an agent writes into its PR descriptions. */
const COMMENTS: { agent: string; comment: RegExp }[] = [
  { agent: "copilot", comment: /<!--\s*START COPILOT CODING AGENT\b/i },
];

/** Co-author addresses of agents (lowercased), other than GitHub apps' noreply addresses. */
const CO_AUTHOR_EMAILS: Record<string, string> = {
  "noreply@anthropic.com": "claude",
  "cursoragent@cursor.com": "cursor",
  "openhands@all-hands.dev": "openhands",
  "noreply@aider.chat": "aider",
};

/** A GitHub noreply address: `NNN+login@users.noreply.github.com`, or the older `login@users.noreply.github.com`. */
const NOREPLY = /^(?:\d+\+)?([^@\s]+)@users\.noreply\.github\.com$/i;

/** The agent a co-author's address belongs to, if any. */
function coAuthorAgent(email: string): string | undefined {
  const address = email.trim().toLowerCase();
  const known = CO_AUTHOR_EMAILS[address];
  if (known) return known;
  const login = NOREPLY.exec(address)?.[1];
  if (!login) return undefined;
  // Only an app's bot account ("claude[bot]") is surely the agent: a person can be called "claude". GitHub reserves
  // the Copilot account, which co-authors the coding agent's commits.
  if (login === "copilot") return "copilot";
  if (!login.endsWith("[bot]")) return undefined;
  return AI_AGENT_LOGINS[login.slice(0, -"[bot]".length)]?.slug;
}

/** Text with fenced code blocks and inline code removed, so a PR quoting a marker isn't taken for one. */
function withoutCode(text: string): string {
  return text
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, "")
    .replace(/`[^`\n]*`/g, "");
}

function footerAgent(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const found = FOOTER_LINES.find((f) => f.line.test(line));
    if (found) return found.agent;
  }
  return undefined;
}

/** The agent a PR description marks, if any. */
export function descriptionAgent(description: string | null | undefined): string | undefined {
  if (!description) return undefined;
  const comment = COMMENTS.find((c) => c.comment.test(description));
  if (comment) return comment.agent;
  const text = withoutCode(description);
  return footerAgent(text) ?? RUN_LINKS.find((l) => l.link.test(text))?.agent;
}

/** The agent a commit message's trailers (or a footer line) mark, if any. */
export function commitAgent(message: string | null | undefined): string | undefined {
  if (!message) return undefined;
  for (const line of message.split(/\r?\n/)) {
    const trailer = /^\s*co-authored-by:\s*[^<\n]*<([^>\n]+)>\s*$/i.exec(line);
    const agent = trailer?.[1] ? coAuthorAgent(trailer[1]) : undefined;
    if (agent) return agent;
    if (/^\s*made-with:\s*cursor\s*$/i.test(line)) return "cursor";
  }
  return footerAgent(withoutCode(message));
}

/** The agent marked on a PR by its description or its last commit's message, the description first. */
export function agentMarker(pr: {
  description?: string | null | undefined;
  commitMessage?: string | null | undefined;
}): AgentMarker | undefined {
  const fromDescription = descriptionAgent(pr.description);
  if (fromDescription) return { agent: fromDescription, in: "description" };
  const fromCommit = commitAgent(pr.commitMessage);
  if (fromCommit) return { agent: fromCommit, in: "commit" };
  return undefined;
}
