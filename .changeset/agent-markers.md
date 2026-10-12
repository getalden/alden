---
"alden": minor
---

The queue recognises an AI agent's PR that a person opened from the marker the agent left: Claude Code's "Generated with Claude Code" footer, a `Co-authored-by` trailer from Claude, Copilot, Cursor, Devin, Jules, Amazon Q, OpenHands or Aider in the last commit, or a link to a Devin, Codex, Cursor or Jules run. It counts for the agent and the person, and the row says how Alden knew ("by Claude (from its last commit)"). Alden reads the description and last commit only for people's PRs, remembers the answer by head commit, and keeps only which agent it found.
