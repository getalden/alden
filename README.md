# Alden

A code review companion. Alden triages the PRs waiting on you, briefs you on what each one touches and what it already checked, and points you at the few places that need your eyes.

> **Status: pre-alpha.** Phase 1 is being built. `alden queue` works today; briefings come next.

## Quickstart

Requires Node 22+.

```sh
npx alden@next auth login   # reuses your GitHub CLI sign-in if you have one
npx alden@next queue        # the PRs waiting on your review, ranked
npx alden@next open 1       # open the top one in your browser
```

`alden queue` splits the PRs waiting on you into two groups:

- **Needs you**, highest priority first. Blocking beats waiting beats risk: urgent labels, PRs stacked on this one, and
  teammates with several PRs waiting on you come first; then how long you've been asked; then size, sensitive paths
  (migrations, auth, payments, CI config, lockfiles), code changed without tests, and files you own in CODEOWNERS. PRs
  with failing CI sink to the bottom with "CI failing: ping @author", since the author has to act first.
- **Fast-track**: small, green, conflict-free PRs that only touch docs, only touch tests, or bump a dependency's patch
  version. In a repo with no CI, only docs-only PRs qualify. Alden only orders them; it never approves anything.

Every row says why it ranks where it does. Narrow the queue with `--repo owner/name` or `--org name` (repeatable), or
get it as JSON with `--json` (schema: [`packages/schema/json`](packages/schema/json)).

Tune it in your settings, for example:

```sh
alden config set queue.fastTrackMaxLines 100
alden config set queue.includeDrafts true
```

## What's coming in phase 1

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
