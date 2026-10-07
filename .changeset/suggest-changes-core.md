---
"alden": minor
---

Suggest changes the way GitHub does: `alden comment <pr> src/pay.ts:12-14 "text" --suggest "code"` (or `--suggest-file <path>`, or `--suggest -` for stdin) drafts a suggested change the author can apply with a click, and `file:12-14` alone writes a comment on several lines. Ranges are checked against the PR's diff (one hunk, one side) when you write them. A suggestion follows its lines across pushes only when every line is found again unchanged; otherwise it's outdated, so it never applies to code it wasn't written against. `alden comment <pr>` and `alden send` show each suggestion as the lines it replaces and the lines it suggests, and code containing backticks is fenced so it can't break the block. Claude Code can draft suggestions too: `alden_draft_comment` takes `start_line` and `suggestion`. A suggestion sent near a flagged place counts as "useful", like a comment.
