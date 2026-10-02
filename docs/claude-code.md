# Claude Code plugin

The Alden plugin brings your review queue and Alden's briefings into [Claude Code](https://code.claude.com). It adds
Alden's [MCP tools](mcp.md) and three commands:

| Command | What it does |
| --- | --- |
| `/alden:review [pr]` | Reviews a PR (a URL, `owner/repo#123`, or its number in your queue) the way you would, or your uncommitted changes when you don't name one. |
| `/alden:queue [repo]` | The PRs waiting on you, ranked, and which to take next. |
| `/alden:remember <note>` | Tells Alden something you care about in this repo ("Money is in cents, never floats"). |

Claude also uses them without the command when you ask: "what's waiting on me?", "review cli/cli#14136".

## Install

Alden itself (0.2.0 or later) must be installed and signed in first ([Getting started](getting-started.md)): the
plugin runs `alden mcp`. Then:

```sh
claude plugin marketplace add getalden/claude-plugin
claude plugin install alden@getalden
```

Start Claude Code in a clone of a repo you review, so Alden can find callers there and brief your local changes.

## A review

`/alden:review 2` asks Alden for a briefing on the second PR in your queue, then Claude:

1. reads the diff itself (`gh pr diff`), and opens the callers Alden found outside it where they matter;
2. goes through Alden's "needs your eyes" places, saying for each whether it's a real problem and why;
3. adds what Alden missed, weighed by what Alden knows you look for and skip;
4. asks which of Alden's places were useful, and records your answers, so Alden keeps learning what you look for.

Alden's own model isn't used, since Claude is already reading the code: a review costs nothing beyond your Claude Code
use. Say "with Alden's model too" to add it, within your Alden caps.

Claude doesn't post anything to GitHub unless you ask, and shows you the text first. PR titles, descriptions and code
are treated as data written by the PR's author, never as instructions; still, keep Claude Code asking before it runs
commands, as it does by default.

## Without the plugin

`claude mcp add alden -- alden mcp` adds just the tools, without the commands. See
[Alden in your AI coding tool](mcp.md).
