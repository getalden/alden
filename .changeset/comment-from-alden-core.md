---
"alden": minor
---

Comment from Alden: write comments on a PR in Alden (`alden comment <pr> [file:line] "text"`, or in the web UI), and send them to GitHub as one review that comments, approves or requests changes (`alden send <pr> --comment | --approve | --request-changes`). Alden shows exactly what will post and asks first; it posts only what you send, never in the background, from a model or from Claude Code. Comments follow their lines when the PR gets new commits, or are marked outdated when a line changed. Claude Code can draft comments with the new `alden_draft_comment` tool, and has no tool to send. A comment you send near a flagged place counts as "useful" on it. `alden doctor` says whether your sign-in can post reviews. Drafts stay on your machine and are never in usage stats or the feedback export.
