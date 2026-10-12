/**
 * Who wrote a PR, as learning sees it: you, a person, a bot, or an AI agent, and which bot or agent. More and more PRs
 * come from agents and bots, and how a reviewer treats them (opens Copilot's PRs first, skips Dependabot's) is worth
 * learning. This works from the author's login and GitHub type, the PR's branch name, and, for a PR a person opened,
 * the marker an agent left in its description or last commit (see `agent-markers.ts`), which the queue reads in one
 * small extra request per batch of such PRs, remembered by head commit. Pure, so the web UI uses it too.
 */

import type { AgentMarker } from "./agent-markers.js";

export type AuthorKind = "you" | "person" | "bot" | "agent";

/**
 * AI coding agents' GitHub apps, by login (lowercased, without "[bot]"), as the slug learning uses and the name it
 * shows. They only count when GitHub says the author is a bot, so a person whose login happens to be "claude" stays a
 * person. Several logins can be one agent: Copilot's coding agent is "Copilot" in GraphQL and "copilot-swe-agent" in
 * REST. Add new agents here; docs/queue.md lists them.
 */
export const AI_AGENT_LOGINS: Record<string, { slug: string; name: string }> = {
  copilot: { slug: "copilot", name: "Copilot" },
  "copilot-swe-agent": { slug: "copilot", name: "Copilot" },
  claude: { slug: "claude", name: "Claude" },
  "devin-ai-integration": { slug: "devin", name: "Devin" },
  cursor: { slug: "cursor", name: "Cursor" },
  "chatgpt-codex-connector": { slug: "codex", name: "Codex" },
  "google-labs-jules": { slug: "jules", name: "Jules" },
  "amazon-q-developer": { slug: "amazon-q", name: "Amazon Q" },
  "sweep-ai": { slug: "sweep", name: "Sweep" },
};

/** Agents that open PRs from an ordinary user account rather than a GitHub app. */
const AI_AGENT_USERS: Record<string, { slug: string; name: string }> = {
  "openhands-agent": { slug: "openhands", name: "OpenHands" },
};

/**
 * Branch prefixes agents push to when a person starts them (the Claude Code GitHub Action, Copilot, Codex, Cursor's
 * background agents, Devin), so a PR a person opened from an agent's work counts as the agent's too.
 */
export const AI_AGENT_BRANCHES: Record<string, string> = {
  "copilot/": "copilot",
  "claude/": "claude",
  "codex/": "codex",
  "cursor/": "cursor",
  "devin/": "devin",
};

/** Bots' names as people say them. Any other bot is shown by its login. */
const BOT_NAMES: Record<string, string> = {
  dependabot: "Dependabot",
  "dependabot-preview": "Dependabot",
  renovate: "Renovate",
  "renovate-bot": "Renovate",
  "github-actions": "GitHub Actions",
  "pre-commit-ci": "pre-commit.ci",
  "snyk-bot": "Snyk",
  mergify: "Mergify",
  imgbot: "Imgbot",
};

/** Bots that open PRs from an ordinary user account, which GitHub doesn't mark as a bot. */
const MACHINE_USERS = new Set(["renovate-bot", "snyk-bot"]);

/** "dependabot[bot]", "app/dependabot" and "Dependabot" are all "dependabot". */
export function loginSlug(login: string): string {
  return login
    .trim()
    .toLowerCase()
    .replace(/^app\//, "")
    .replace(/\[bot\]$/, "");
}

/** Agents Alden only knows by the marker they leave on a commit, never by an account. */
const AI_AGENT_TOOLS: Record<string, { slug: string; name: string }> = {
  aider: { slug: "aider", name: "Aider" },
};

const agentNames = new Map(
  [...Object.values(AI_AGENT_LOGINS), ...Object.values(AI_AGENT_USERS), ...Object.values(AI_AGENT_TOOLS)].map((a) => [
    a.slug,
    a.name,
  ]),
);

/** How Alden knew a PR was an agent's: its account, its branch, or the agent's marker in its description or commit. */
export type AgentVia = "account" | "branch" | "description" | "commit";

export interface PrAuthor {
  kind: AuthorKind;
  /** The bot or agent as a slug ("dependabot", "copilot"), or a person's lowercased login. Absent for you. */
  id?: string;
  /** For an agent's PR that a person opened (from the agent's branch, or with its marker): their lowercased login. */
  person?: string;
  /** For an agent's PR a person opened: how Alden knew it was the agent's. Absent when the agent's account opened it. */
  via?: Exclude<AgentVia, "account">;
}

/**
 * Who wrote a PR. A bot is anything GitHub calls a Bot or whose login ends in "[bot]"; a bot that's a known AI agent
 * is an agent. A PR a person opened from an agent's branch, or that carries an agent's marker (`agentMarker`, from its
 * description or last commit), is the agent's (and the person's).
 */
export function prAuthor(
  pr: { author: string | null; authorIsBot: boolean; headRef?: string; agentMarker?: AgentMarker | undefined },
  viewer?: string,
): PrAuthor | undefined {
  if (!pr.author) return undefined;
  const slug = loginSlug(pr.author);
  const isBot = pr.authorIsBot || /\[bot\]$/i.test(pr.author.trim()) || MACHINE_USERS.has(slug);
  const agent = isBot ? AI_AGENT_LOGINS[slug] : AI_AGENT_USERS[slug];
  if (agent) return { kind: "agent", id: agent.slug };
  if (isBot) return { kind: "bot", id: slug };
  const mine = viewer !== undefined && slug === viewer.toLowerCase();
  const branch = pr.headRef?.toLowerCase() ?? "";
  const viaAgent = Object.entries(AI_AGENT_BRANCHES).find(([prefix]) => branch.startsWith(prefix));
  if (viaAgent) return { kind: "agent", id: viaAgent[1], ...(mine ? {} : { person: slug }), via: "branch" };
  const marker = pr.agentMarker;
  if (marker) return { kind: "agent", id: marker.agent, ...(mine ? {} : { person: slug }), via: marker.in };
  return mine ? { kind: "you" } : { kind: "person", id: slug };
}

/** "dependabot" → "Dependabot"; an unknown bot or agent keeps its login. */
export function authorName(kind: "bot" | "agent", id: string): string {
  return (kind === "agent" ? agentNames.get(id) : BOT_NAMES[id]) ?? id;
}

/**
 * The note a queue row shows for an agent's PR that a person opened, saying how Alden knew: "by Claude (from its last
 * commit)". Undefined for anything else: an agent's own account already says who it is.
 */
export function agentNote(author: PrAuthor | undefined): string | undefined {
  if (author?.kind !== "agent" || !author.id || !author.via) return undefined;
  const from = { branch: "its branch", description: "its description", commit: "its last commit" }[author.via];
  return `by ${authorName("agent", author.id)} (from ${from})`;
}
