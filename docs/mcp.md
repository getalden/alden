# Alden in your AI coding tool

`alden mcp` gives an AI coding tool (Claude Code, Cursor, Claude Desktop, or anything else that speaks the
[Model Context Protocol](https://modelcontextprotocol.io)) Alden's queue, briefings and memory as tools. Ask "what's
waiting on me?" or "review PR 3 the way I would" and the assistant uses Alden's checks, the callers it finds outside the
diff, and what Alden knows you look for, then adds its own reading of the code.

It's the same Alden as the terminal and `alden ui`: your GitHub sign-in, your settings and your memory, all on your
machine.

## Add it

**Claude Code**, in a clone of a repo you review (Alden finds callers in the clone the tool starts it in):

```sh
claude mcp add alden -- alden mcp
```

Add `--scope user` to have it in every project. For the slash command `/alden:review` as well, install the Claude Code
plugin instead: see [Claude Code plugin](claude-code.md).

**Cursor**: in `.cursor/mcp.json` (or `~/.cursor/mcp.json` for every project):

```json
{ "mcpServers": { "alden": { "command": "alden", "args": ["mcp"] } } }
```

**Claude Desktop**: in Settings → Developer → Edit Config, add the same `alden` entry under `mcpServers`. Apps opened
from the Finder may not find `alden` on your PATH, so give its full path (`which alden` prints it, e.g.
`/opt/homebrew/bin/alden`). Claude Desktop has no project folder, so point Alden at a clone for callers and local changes:
`"args": ["mcp", "--dir", "/path/to/your/clone"]`.

Sign in to GitHub first (`alden auth login`); the tools say so if you haven't.

## The tools

| Tool | What it does | Arguments (default) |
| --- | --- | --- |
| `alden_queue` | The PRs waiting on your review, ranked, each with why it's there. | `repos`, `orgs`, `limit` 1–100 per lane (15), `refresh` (false) |
| `alden_review` | A briefing on a PR (a URL, `owner/repo#123`, or its number in the queue), or on your uncommitted changes when no PR is given. Includes what you care about in that repo. | `pr` (none: your local changes), `callers` (true), `use_alden_model` (false), `model`, `effort` `low` to `max` |
| `alden_feedback` | Records useful, not useful or dismiss on a place in a briefing, by its id (`E1`, `F2`, `C:tests.missing`), and says how close it brought a lesson. | `place`, `verdict` `useful`, `not_useful`, `dismiss` or `clear`, `pr` (the latest briefing) |
| `alden_missed` | Records something Alden should have flagged. | `note` (up to 2,000 characters), `path`, `line`, `pr` (the latest briefing) |
| `alden_memory` | What Alden knows about you in a repo. | `repo` (this clone's `origin`) |
| `alden_remember` | Adds a note to it ("Money is in cents, never floats"). | `text` (up to 500 characters), `repo` (this clone's `origin`) |
| `alden_draft_comment` | Drafts a review comment for you, on a line or lines of the PR's diff or as a general note, or a suggested change you can apply on GitHub. It isn't posted: you review it and send it from the UI or with `alden send`. | `pr`, `path` and `line` (none: a general note), `start_line` (for several lines, in one hunk), `side` `RIGHT` or `LEFT` (RIGHT), `body` (optional with a suggestion), `suggestion` (replacement code for the line(s), new side only; empty deletes them) |

Each place in a briefing lists the files to look at too, when the code graph ran: callers of the changed code, tests
that use it, and files importing it, each with its line (see [Related files](code-graph.md#related-files)).

The assistant records feedback when you react ("that first one wasn't useful"), so Alden keeps learning what you look
for wherever you review. It's told to record only what you said, never its own opinion.

Ask it to write a comment, or to suggest a change, and it drafts one in Alden with `alden_draft_comment`, marked as drafted by Claude Code
(or whichever tool you use). Alden posts only what you send from the UI or terminal: the assistant can draft
comments, you review and send. There is deliberately no tool to send, approve or request changes. See
[Comments and sending a review](comments.md).

## The model

By default `alden_review` doesn't ask the model you set up for Alden: the assistant you're talking to is already a
model, so it reasons over Alden's checks and the code graph and reads the diff itself, and Alden costs nothing extra.
Ask for "Alden's model too" and it passes `use_alden_model`, which uses your Alden model within your caps, as
`alden review` does.

## Safety

- Everything Alden returns that came from a PR (titles, descriptions, paths, code) is marked as written by the PR's
  author, and the assistant is told to treat it as data, never instructions. A PR can still try to talk to the
  assistant through its text, so keep your tool asking before it runs commands, as it does by default.
- The tools read from GitHub and write only to Alden's own database on your machine (feedback, notes and comment
  drafts). Nothing posts to GitHub: only you send a review, from the UI or `alden send`. Forgetting memory is left to you, in `alden memory` or `alden ui`.
- With usage stats on, these tools count like any other use, marked as coming from an AI coding tool. See
  [Usage stats](telemetry.md).
