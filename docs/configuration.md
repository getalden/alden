# Configuration

## Where settings live

Alden merges three layers, later ones winning:

1. Built-in defaults.
2. Your user config: `~/.alden/config.toml` (`alden config path` prints it).
3. The repo's config: `.alden.toml` at the root of the repo you run Alden from.

`alden config set` writes to your user config. Edit `.alden.toml` by hand to share settings with a team, for example
sensitive paths. `alden config list` prints the merged result.

```toml
# ~/.alden/config.toml
[model]
name = "sonnet"
effort = "medium"

[budget]
perReviewUsd = 0.5
dailyUsd = 10

[queue]
fastTrackMaxLines = 50
```

## model

| Key | Default | What it does |
| --- | --- | --- |
| `model.provider` | `anthropic` | `anthropic`, `bedrock`, `vertex`, `foundry` or `openai-compatible`. |
| `model.name` | `sonnet` | An alias (`sonnet`, `opus`, `haiku`, `fable`), a full model ID, or a local model's name. |
| `model.effort` | unset | `low`, `medium`, `high`, `xhigh` or `max`. Unset uses the model's own default. |
| `model.baseUrl` | `http://localhost:11434/v1` | `openai-compatible` only: the endpoint. |
| `model.region` | unset | `bedrock` (AWS region) and `vertex` (GCP region, e.g. `global`). |
| `model.projectId` | unset | `vertex` only: the GCP project ID. |
| `model.resource` | unset | `foundry` only: the Azure AI Foundry resource name. |

See [Models, providers and budgets](models.md).

## budget

| Key | Default | What it does |
| --- | --- | --- |
| `budget.perReviewUsd` | `0.5` | The most one review may cost, in US dollars. |
| `budget.dailyUsd` | `10` | The most all reviews may cost in your local day. |

## queue

| Key | Default | What it does |
| --- | --- | --- |
| `queue.includeDrafts` | `false` | Include draft PRs in `alden queue`. |
| `queue.fastTrackMaxLines` | `50` | The largest PR, in changed lines, that can be fast-tracked. |
| `queue.sensitivePaths` | see below | Glob patterns that raise a PR's risk and trigger the sensitive-paths check. Setting it replaces the defaults. |

Default sensitive paths:

```text
**/migrations/**      **/auth/**         **/payments/**      **/infra/**
.github/workflows/**  **/package-lock.json  **/pnpm-lock.yaml  **/yarn.lock
**/composer.lock      **/go.sum          **/poetry.lock
```

## Environment variables

| Variable | What it does |
| --- | --- |
| `ALDEN_GITHUB_TOKEN` | A GitHub token to use instead of the stored one. |
| `ALDEN_HOME` | Where Alden keeps its files. Default `~/.alden`. |
| `ALDEN_OPENAI_API_KEY` | The key for an `openai-compatible` endpoint (falls back to `OPENAI_API_KEY`). |
| `ANTHROPIC_API_KEY` | Your Anthropic API key, for the `anthropic` provider. |

## Files Alden keeps

Everything is under `~/.alden` (or `ALDEN_HOME`):

| Path | What it holds |
| --- | --- |
| `config.toml` | Your user settings. |
| `cache/` | GitHub responses, cached briefly, and your last queue (for `alden open` and `alden review <#>`). |
| `index/` | The code graph's per-file cache. |
| `worktrees/` | Checkouts of PRs for the code graph, one per repo. |
| `spend/` | The model spend ledger, one file per day. |

Deleting any of these is safe. Alden rebuilds them as needed; deleting `spend/` resets today's daily cap.
