# Alden documentation

Alden is a code review companion. It ranks the PRs waiting on you, briefs you on what each one touches and what it
already checked, and points you at the few places that need your eyes. It runs on your machine, with your own GitHub
sign-in and your own model account.

> **Open beta.** Anyone can [install it](getting-started.md), and it's free during the beta. Commands and output
> formats may still change before 1.0. Questions and ideas: the
> [Alden Community on Discord](https://discord.gg/ZtXFX7sxTu).

![A Django PR's briefing in alden ui: the places that need your eyes, what Alden checked, and what it didn't](../site/src/assets/screens/briefing-dark.png)

## Start here

- [Get started](getting-started.md): install, sign in, and your first queue and briefing.
- [Your review queue](queue.md): how PRs are ranked, Your turn, and fast-track.
- [Briefings and checks](checks.md): what `alden review` checks, and how it picks where to look.
- [Pick a model](models.md): Anthropic, OpenAI, cloud platforms, local models, caps and spend.
- [Privacy and data](privacy.md): what leaves your machine, and what never does.
- [Troubleshooting](troubleshooting.md): `alden doctor`, signing in at a company, and common errors.

## Where you use it

| Surface      | Start it with   | Good for                                               |
| ------------ | --------------- | ------------------------------------------------------ |
| Terminal     | `alden queue`   | Fast triage in text                                    |
| Browser      | `alden ui`      | Briefings, the diff, and the Comments drawer           |
| Desktop app  | `Alden.app`     | Briefings ready in the menu bar while you're away      |
| Claude Code  | `/alden:review` | Reviewing without leaving your session                 |
| MCP clients  | `alden mcp`     | Your queue in Cursor and other tools, read-only        |

## More help

Ask in the [Alden Community on Discord](https://discord.gg/ZtXFX7sxTu), where you can also tell us what works and what
doesn't. For errors, start with `alden doctor` and [Troubleshooting](troubleshooting.md).

## All pages

### Get started

- [Getting started](getting-started.md): install, sign in, and your first queue and review.
- [Commands](commands.md): every command and flag.

### Reviewing

- [The review queue](queue.md): how PRs are ranked, and what "fast-track" means.
- [Briefings and checks](checks.md): what `alden review` checks, and how it picks where to look.
- [Comments and sending](comments.md): write comments in Alden, and send them to GitHub as one review.
- [Learning and memory](memory.md): what Alden learns from your feedback, your notes, and how to forget.
- [The code graph](code-graph.md): callers outside the diff, languages, and PR checkouts.

### Where you use it

- [Alden in your browser](web-ui.md): `alden ui`, a guide to the queue, briefings, the diff and sending a review.
- [The desktop app](desktop.md): Alden in a window and the macOS menu bar, with briefings ready while you're away.
- [Claude Code plugin](claude-code.md): `/alden:review` and your queue in Claude Code.
- [MCP](mcp.md): `alden mcp` for Claude Code, Cursor and other MCP clients.

### Set up

- [Models and budgets](models.md): choosing a model, cloud platforms, local models, caps and spend.
- [Configuration](configuration.md): every setting, and where settings live.

### Trust

- [Privacy and data](privacy.md): what leaves your machine, and what Alden stores.
- [Usage stats](telemetry.md): the opt-in telemetry, every event it can send, and how to turn it off.
- [Security model](security.md): what Alden protects, from whom, and how.

### Help

- [Troubleshooting](troubleshooting.md): common errors and their fixes. Start with `alden doctor`.

### Contributing

- [Architecture](architecture.md): the packages and how a review flows through them.
- [Evals](evals.md): measuring briefing quality on recorded PRs, the gate, and the end-to-end test kit.
- [CONTRIBUTING.md](../CONTRIBUTING.md): setup, tests and pull requests.
- [RELEASING.md](../RELEASING.md): versioning, the release workflow, and checking a release.
