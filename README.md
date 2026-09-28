# Alden

A code review companion. Alden triages the PRs waiting on you, briefs you on what each one touches and what it already checked, and points you at the few places that need your eyes.

> **Status: pre-alpha.** Phase 1 is being built. Nothing is published to npm yet.

## What's coming in phase 1

- `alden queue` ranks the PRs waiting on you and splits them into "needs you" and "fast-track".
- `alden review <PR>` briefs you on a PR: blast radius, what Alden checked (with evidence), and at most 3 places to look.
- `alden review` does the same for your uncommitted local changes, before you open a PR.
- `alden ui` shows the queue and briefings in a local web UI.
- `alden stats` shows your repo's time to first review and review cycle time.

Alden is GitHub-only for now and supports TypeScript/JavaScript, Python, PHP (Laravel, Symfony) and Go.

## Models and spending

Alden uses your own model account. The default is Claude Sonnet via an Anthropic API key, capped at $0.50 per review and $10 per day. You can switch model, provider (Bedrock, Vertex, Foundry, or any OpenAI-compatible endpoint such as Ollama) and caps:

```sh
alden config set model.name opus
alden config set budget.dailyUsd 20
alden config list
```

Settings live in `~/.alden/config.toml`. A repo can override them in `.alden.toml`.

## Development

Requires Node 22+ and pnpm 10.

```sh
pnpm install
pnpm test        # Vitest
pnpm typecheck   # tsc across packages
pnpm lint        # Biome
pnpm build       # bundles the CLI into packages/cli/dist
node packages/cli/dist/index.js --help
```

| Package | What it is |
| --- | --- |
| `packages/cli` | The `alden` command. The only published package; bundles the others. |
| `packages/core` | The engine: config, GitHub, queue ranking, review. |
| `packages/schema` | Shared data formats (config, queue items, briefings) that the CLI, UI and desktop app all render. |
| `packages/ui` | The local web UI. Placeholder until week 7. |

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
