# Alden for Claude Code

[Alden](https://getalden.dev) is a code review companion: it ranks the PRs waiting on you and briefs you on each one,
with the callers the diff leaves out and what it has learned you look for. This plugin brings it into
[Claude Code](https://code.claude.com).

| Command | What it does |
| --- | --- |
| `/alden:review [pr]` | Reviews a PR (a URL, `owner/repo#123`, or its number in your queue) the way you would, or your uncommitted changes when you don't name one, and records which of Alden's flags you found useful. |
| `/alden:queue [repo]` | The PRs waiting on you, ranked, and which to take next. |
| `/alden:remember <note>` | Tells Alden something you care about in this repo. |

Claude also uses Alden without the commands when you ask: "what's waiting on me?", "review cli/cli#14136".

## Install

Install Alden 0.6.0 or later and sign in first ([getting started](https://getalden.dev/docs/getting-started/)):

```sh
brew install getalden/tap/alden      # or: npm install -g alden@next
alden auth login
```

Then add this marketplace and the plugin:

```sh
claude plugin marketplace add getalden/claude-plugin
claude plugin install alden@getalden
```

Start Claude Code in a clone of a repo you review, so Alden can find callers there. More in the
[plugin docs](https://getalden.dev/docs/claude-code/).

## Data

Alden runs on your machine; there is no Alden server. What the plugin reads and learns (your feedback, the PRs you open, your notes) stays in `~/.alden/alden.db`. It sends data to:

- **GitHub**, with your token: review requests, PR details, diffs, CI status, and git fetches of PRs for the code graph. Reviews are posted only when you send them yourself; Claude can draft comments but cannot send them.
- **Claude Code**, through `alden mcp`: queue rows, briefings including PR text and code, and your notes, which reach Claude Code's model provider from there.
- **Your own model provider** (an Anthropic key or a local model), only when you run `alden review` from the command line with a model set up.
- **PostHog (EU)**, only if you said yes to anonymous usage stats: never code, titles, paths, repo or user names.
- **The npm registry**, at most once a day, to check for a newer Alden version.

Details: [Privacy and data](https://getalden.dev/docs/privacy/).

## About this repo

It's published from Alden's main repo on every release, so changes made here are overwritten. Questions and problems: the
[Alden Community on Discord](https://discord.gg/ZtXFX7sxTu).
