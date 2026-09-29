# Alden

A code review companion. Alden triages the PRs waiting on you, briefs you on what each one touches and what it already checked, and points you at the few places that need your eyes.

> **Status: pre-alpha.** Phase 1 is being built. `alden queue` and `alden review` (with or without a model) work today.

## Quickstart

Requires Node 22+.

```sh
npx alden@next auth login   # reuses your GitHub CLI sign-in if you have one
npx alden@next queue        # the PRs waiting on your review, ranked
npx alden@next open 1       # open the top one in your browser

npx alden@next review 1     # brief yourself on #1 from the queue
npx alden@next review       # or on your own uncommitted changes, before opening a PR
```

`alden review` takes a PR URL, `owner/repo#123`, or a # from your last queue. It prints the few places that need
your eyes, every check Alden ran with its evidence (secrets, migrations, public signatures, dependencies, tests,
config, sensitive paths, CI), and what it did not check. Checks marked `~` infer from the diff alone. Add `--json` for
the briefing as data.

For TypeScript, JavaScript, Python and Go, Alden also builds a code graph of the repo and lists the callers outside the
diff of every changed public function, class and method, flagging removed or re-signed code that's still called. Local
reviews use your working tree. For PR reviews, run `alden review` from a clone of the PR's repo: Alden fetches the PR
into its own worktree under `~/.alden/worktrees` (your checkout is never touched). PHP comes next. `--no-graph`
skips it.

With an Anthropic API key (`ANTHROPIC_API_KEY`, or `ant auth login`), the review also asks a model what the change
does, whether it matches its title, and what else deserves a look. Alden keeps only findings that point at real lines
in the diff, and never lets them displace high-severity checks. Use `--model opus` for one review, or `--no-llm` to
skip the model. Every call is checked against your caps before it's sent; `alden spend` shows what you've spent.

```text
Needs your eyes
  1. Public API change in public/app/features/explore/SignalExplorer/data/metricResourceClient.ts:191
     changed: export function fetchCatalog(…): Promise<MetricInfo[]> → export function fetchCatalog(…): Promise<Catalog>
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

## Documentation

See [docs/](docs/README.md): getting started, every command and setting, how the queue and checks work, the code
graph, models and budgets, privacy, and troubleshooting.

## What's coming in phase 1

- The code graph for PHP (Laravel, Symfony).
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

Settings live in `~/.alden/config.toml`. A repo can override them in `.alden.toml`. See
[Models, providers and budgets](docs/models.md) and [Configuration](docs/configuration.md).

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
