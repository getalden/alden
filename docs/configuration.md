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
| `queue.orgs` | `[]` | Only PRs in these organisations' (or users') repos. Empty means everywhere. Your user config only. |
| `queue.repos` | `[]` | Only PRs in these repos (`owner/name`); with `queue.orgs`, a PR in either counts. Your user config only. |
| `queue.ignore` | `[]` | Organisations or repos (`owner/name`) to leave out, even when covered above. Your user config only. |
| `queue.rank.<weight>` | `1` | How much a ranking signal counts, 0 to 10: `urgentLabel`, `stacked`, `sameAuthor`, `ownsFiles`, `waiting`, `size`, `risk`, `noTests`, `learned`, `rereview`. 0 ignores it, 2 doubles it. Your user config only. |
| `queue.rank.rules` | `[]` | Rules that put PRs first or last, or boost or lower them (`[[queue.rank.rules]]`). Your user config only. |

`queue.orgs`, `queue.repos` and `queue.ignore` set what your queue covers on this machine, everywhere Alden shows it
(the terminal, the web UI, the desktop app's menu and background briefings, and `alden mcp`): only your company's
organisation on a work laptop, say, and only your own repos on a personal one. Set them in Settings → Your queue on this
machine, or with `alden config set queue.orgs "acme"` (lists are comma-separated). `--repo` and `--org` override
them for one run. A repo's `.alden.toml` can't set them.

`[queue.rank]` is how you rank: a weight per signal and your rules. Set it in Settings → Ranking, which previews your
queue's top 5 before you save, with `alden config set queue.rank.waiting 2`, or by hand:

```toml
[queue.rank]
waiting = 2
learned = 0

[[queue.rank.rules]]
when = { path = "payments/" }
then = "first"

[[queue.rank.rules]]
when = { author = "bots" }
then = "last"
```

Each rule's `when` takes any of `path`, `label`, `author` (a login, or `people`, `bots`, `agents`), `repo`, `base` and
`title`; `then` is `first`, `last`, `boost` or `lower`, with `by` for the points (default 5) and an optional `name`
for the row. See [Your ranking](queue.md#your-ranking) for what each weight is worth and how rules apply, and
`packages/schema/json/rank-settings.v1.json` for the format. A repo's `.alden.toml` can't set them.

Default sensitive paths:

```text
**/migrations/**      **/auth/**         **/payments/**      **/infra/**
.github/workflows/**  **/package-lock.json  **/pnpm-lock.yaml  **/yarn.lock
**/composer.lock      **/go.sum          **/poetry.lock
```

## review

| Key | Default | What it does |
| --- | --- | --- |
| `review.eyes` | `3` | How many places "Needs your eyes" holds, 1 to 10: the few a careful reviewer would look at first. More catches more, and asks more of your attention. |

## background

For the [desktop app](desktop.md#while-youre-away), which briefs your top PRs while you're away.

| Key | Default | What it does |
| --- | --- | --- |
| `background.enabled` | `true` | Prepare briefings in the background. A repo's `.alden.toml` can turn it off there. |
| `background.model` | `false` | Ask the model for them too, within your caps. Read from your user config only, so a repo can't make you spend. |
| `background.prepare` | `3` | How many of the top PRs in Needs you to keep briefed, 0 to 10, in your [ranked order](queue.md#your-ranking). 0 briefs none. |

## notifications

For the [desktop app](desktop.md#while-youre-away).

| Key | Default | What it does |
| --- | --- | --- |
| `notifications.sound` | `true` | Play the system's notification sound with "Briefing ready" and follow-ups. Read from your user config only. Settings → Notifications sets it too. |
| `notifications.followUps` | `"your-turn"` | How much you hear about PRs you reviewed: `off`, `rereview` (a second review request), `your-turn` (a re-review, or every comment you left resolved or answered) or `every-reply` (each reply, resolve, re-review and outdated comment). See [Follow-ups](desktop.md#follow-ups-on-prs-you-reviewed). Any PR can have its own level with [`alden watch`](commands.md#alden-watch). Read from your user config only. Settings → Notifications sets it too. |

## learning

| Key | Default | What it does |
| --- | --- | --- |
| `learning.fromReviews` | `true` | Learn from the reviews you send: comments and suggestions near Alden's flags, approving past a place you saw, comments where it flagged nothing, and what the author did with your comments afterwards (suggestions applied, comments resolved). Off records none of it: Alden notes nothing about what you saw, keeps no record of where your comments went and asks GitHub nothing about them; Useful and Not useful still count, and what was already learned stays. Read from your user config only. Settings → Learning sets it too. See [Reviews you send](memory.md#reviews-you-send), [Places you saw](memory.md#places-you-saw) and [What comes of them](memory.md#what-comes-of-them). |

## telemetry

| Key | Default | What it does |
| --- | --- | --- |
| `telemetry.enabled` | unset | Send anonymous usage stats. Read from your user config only. `DO_NOT_TRACK`, `ALDEN_TELEMETRY=0` and CI turn it off. See [Usage stats](telemetry.md). |

## clones

| Key | Default | What it does |
| --- | --- | --- |
| `clones.folders` | `[]` | Folders your clones live in, e.g. `~/src`. Searched (three levels down) for a clone of a PR's repo, so its briefing finds callers from anywhere. Your user config only. |

PR briefings find callers in a local clone of the PR's repo. Alden uses, in order: the clone it runs in, if it has a
remote for that repo; the clone it last saw for that repo (Alden remembers every clone with a GitHub remote it runs in,
and checks the folder is still there and still has that remote); then the first clone under `clones.folders`. So
`alden config set clones.folders "~/src"` once is enough for the desktop app, `alden ui` or `alden mcp` started anywhere
to find callers in every repo under `~/src`.

## updates

| Key | Default | What it does |
| --- | --- | --- |
| `updates.check` | `true` | `alden --version` and `alden doctor` say when a newer Alden exists (checked at most once a day). |

## Environment variables

| Variable | What it does |
| --- | --- |
| `ALDEN_DEBUG` | `queue` prints where a fresh queue's time goes, step by step, on stderr. See [The review queue](queue.md). |
| `ALDEN_GITHUB_TOKEN` | A GitHub token to use instead of the stored one. |
| `ALDEN_HOME` | Where Alden keeps its files. Default `~/.alden`. |
| `ALDEN_NO_UPDATE_CHECK` | Set to anything to skip the check for a newer Alden. |
| `ALDEN_OPENAI_API_KEY` | The key for an `openai-compatible` endpoint (falls back to `OPENAI_API_KEY`). |
| `ALDEN_TELEMETRY` | `0` or `false` turns usage stats off, whatever your config says. |
| `ANTHROPIC_API_KEY` | Your Anthropic API key, for the `anthropic` provider. Comes before the key stored with `alden auth model`. |
| `DO_NOT_TRACK` | Set (to anything but `0`) to turn usage stats off. |
| `OLLAMA_HOST` | Where Ollama listens, as Ollama reads it, for `alden setup`. Default `http://localhost:11434`. |

## Files Alden keeps

Everything is under `~/.alden` (or `ALDEN_HOME`):

| Path | What it holds |
| --- | --- |
| `config.toml` | Your user settings. |
| `credentials.json` | Your GitHub token and Anthropic key, only where there's no OS keychain (readable by you only). |
| `cache/` | GitHub responses, cached briefly, and your last queue (for `alden open` and `alden review <#>`). |
| `index/` | The code graph's per-file cache. Around 100 MB for a repo the size of Kubernetes. |
| `worktrees/` | Checkouts of PRs for the code graph, one per repo. |
| `alden.db` | The local database: feedback, the PRs you open, your notes, your draft comments, the places you saw (90 days), where your sent line comments went (30 days, without their text), model spending, first use per repo, the follow-ups on PRs you reviewed (each thread of yours as last seen, and the news not yet shown; 30 days) and the PRs you gave their own level, queued usage stats, the clone Alden last saw for each repo, and this install's anonymous id and salt. See [Learning and memory](memory.md). |
| `legacy/` | Files from before the database, kept after their one-time import. Safe to delete. |

Deleting any of these is safe, but deleting `alden.db` also deletes your feedback, notes and what Alden learned, and
resets today's daily cap. Alden rebuilds everything else as needed.
