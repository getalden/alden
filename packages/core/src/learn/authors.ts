/**
 * Who wrote a PR (you, a person, a bot or an AI agent) lives in `@alden/schema`, so the web UI's queue filters and
 * learning classify authors the same way. Re-exported here for learning and ranking.
 */
export {
  type AgentMarker,
  AI_AGENT_BRANCHES,
  AI_AGENT_LOGINS,
  type AuthorKind,
  agentMarker,
  agentNote,
  authorName,
  loginSlug,
  type PrAuthor,
  prAuthor,
} from "@alden/schema";
