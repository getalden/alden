# Alden documentation

Alden is a code review companion. It ranks the PRs waiting on you, briefs you on what each one touches and what it
already checked, and points you at the few places that need your eyes. It runs on your machine, with your own GitHub
sign-in and your own model account.

> **Status: pre-alpha.** Commands and output formats may still change before 1.0.

## Using Alden

- [Getting started](getting-started.md): install, sign in, and your first queue and review.
- [Commands](commands.md): every command and flag.
- [The review queue](queue.md): how PRs are ranked, and what "fast-track" means.
- [Briefings and checks](checks.md): what `alden review` checks, and how it picks where to look.
- [The code graph](code-graph.md): callers outside the diff, languages, and PR checkouts.
- [Models, providers and budgets](models.md): choosing a model, cloud platforms, local models, caps and spend.
- [Configuration](configuration.md): every setting, and where settings live.
- [Privacy and data](privacy.md): what leaves your machine, and what Alden stores.
- [Troubleshooting](troubleshooting.md): common errors and their fixes.

## Working on Alden

- [Architecture](architecture.md): the packages and how a review flows through them.
- [Evals](evals.md): measuring briefing quality on recorded PRs.
- [CONTRIBUTING.md](../CONTRIBUTING.md): setup, tests and pull requests.
