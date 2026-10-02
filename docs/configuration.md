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

## background

For the [desktop app](desktop.md#while-youre-away), which briefs your top PRs while you're away.

| Key | Default | What it does |
| --- | --- | --- |
| `background.enabled` | `true` | Prepare briefings in the background. A repo's `.alden.toml` can turn it off there. |
| `background.model` | `false` | Ask the model for them too, within your caps. Read from your user config only, so a repo can't make you spend. |

## telemetry

| Key | Default | What it does |
| --- | --- | --- |
| `telemetry.enabled` | unset | Send anonymous usage stats. Read from your user config only. `DO_NOT_TRACK`, `ALDEN_TELEMETRY=0` and CI turn it off. See [Usage stats](telemetry.md). |

## updates

| Key | Default | What it does |
| --- | --- | --- |
| `updates.check` | `true` | `alden --version` and `alden doctor` say when a newer Alden exists (checked at most once a day). |

## Environment variables

| Variable | What it does |
| --- | --- |
| `ALDEN_GITHUB_TOKEN` | A GitHub token to use instead of the stored one. |
| `ALDEN_HOME` | Where Alden keeps its files. Default `~/.alden`. |
| `ALDEN_NO_UPDATE_CHECK` | Set to anything to skip the check for a newer Alden. |
| `ALDEN_OPENAI_API_KEY` | The key for an `openai-compatible` endpoint (falls back to `OPENAI_API_KEY`). |
| `ALDEN_TELEMETRY` | `0` or `false` turns usage stats off, whatever your config says. |
| `ANTHROPIC_API_KEY` | Your Anthropic API key, for the `anthropic` provider. |
| `DO_NOT_TRACK` | Set (to anything but `0`) to turn usage stats off. |

## Files Alden keeps

Everything is under `~/.alden` (or `ALDEN_HOME`):

| Path | What it holds |
| --- | --- |
| `config.toml` | Your user settings. |
| `cache/` | GitHub responses, cached briefly, and your last queue (for `alden open` and `alden review <#>`). |
| `index/` | The code graph's per-file cache. Around 100 MB for a repo the size of Kubernetes. |
| `worktrees/` | Checkouts of PRs for the code graph, one per repo. |
| `alden.db` | The local database: feedback, the PRs you open, your notes, model spending, first use per repo, queued usage stats, and this install's anonymous id and salt. See [Learning and memory](memory.md). |
| `legacy/` | Files from before the database, kept after their one-time import. Safe to delete. |

Deleting any of these is safe, but deleting `alden.db` also deletes your feedback, notes and what Alden learned, and
resets today's daily cap. Alden rebuilds everything else as needed.
