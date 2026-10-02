# Alden documentation

Alden is a code review companion. It ranks the PRs waiting on you, briefs you on what each one touches and what it
already checked, and points you at the few places that need your eyes. It runs on your machine, with your own GitHub
sign-in and your own model account.

> **Status: pre-alpha.** Commands and output formats may still change before 1.0.

## Using Alden

- [Getting started](getting-started.md): install, sign in, and your first queue and review.
- [Commands](commands.md): every command and flag.
- [The web UI](web-ui.md): `alden ui`, its views, keyboard and security.
- [The desktop app](desktop.md): Alden in a window and the macOS menu bar.
- [Claude Code plugin](claude-code.md): `/alden:review` and your queue in Claude Code.
- [Alden in your AI coding tool](mcp.md): `alden mcp` for Claude Code, Cursor and other MCP clients.
- [The review queue](queue.md): how PRs are ranked, and what "fast-track" means.
- [Briefings and checks](checks.md): what `alden review` checks, and how it picks where to look.
- [Learning and memory](memory.md): what Alden learns from your feedback, your notes, and how to forget.
- [The code graph](code-graph.md): callers outside the diff, languages, and PR checkouts.
- [Models, providers and budgets](models.md): choosing a model, cloud platforms, local models, caps and spend.
- [Configuration](configuration.md): every setting, and where settings live.
- [Privacy and data](privacy.md): what leaves your machine, and what Alden stores.
- [Usage stats](telemetry.md): the opt-in telemetry, every event it can send, and how to turn it off.
- [Security model](security.md): what Alden protects, from whom, and how.
- [Troubleshooting](troubleshooting.md): common errors and their fixes. Start with `alden doctor`.

## Working on Alden

- [Architecture](architecture.md): the packages and how a review flows through them.
- [Evals](evals.md): measuring briefing quality on recorded PRs.
- [CONTRIBUTING.md](../CONTRIBUTING.md): setup, tests and pull requests.
