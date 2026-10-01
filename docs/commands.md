# Commands

Run `alden <command> --help` for the same information in your terminal.

## alden auth

Sign in to GitHub.

| Command | What it does |
| --- | --- |
| `alden auth login` | Uses the GitHub CLI's sign-in if there is one. Otherwise signs you in with a code in your browser and stores the token. |
| `alden auth login --device` | Signs in with a code in your browser, even if the GitHub CLI is signed in. |
| `alden auth login --with-token` | Reads a token from standard input, e.g. `echo $TOKEN \| alden auth login --with-token`. |
| `alden auth status` | Shows the account Alden is using, where the token comes from, and its scopes. |
| `alden auth logout` | Removes the token Alden stored. Doesn't touch the GitHub CLI's sign-in. |

Alden looks for a token in this order:

1. The `ALDEN_GITHUB_TOKEN` environment variable.
2. The token Alden stored, in the OS keychain (or, where there's no keychain, a file only you can read).
3. The GitHub CLI's token (`gh auth token`).

## alden queue

Ranks the open PRs waiting on your review. See [The review queue](queue.md).

| Flag | What it does |
| --- | --- |
| `--repo <owner/name>` | Only this repo. Repeat for more. |
| `--org <name>` | Only repos in this organisation. Repeat for more. |
| `--limit <n>` | The most PRs to fetch. Default 100. |
| `--include-drafts` | Include draft PRs. |
| `--refresh` | Ignore the 60-second cache. |
| `--json` | Print the ranked queue as JSON. Schema: `packages/schema/json/ranked-queue.v1.json`. |

## alden open

```sh
alden open <#>
```

Opens a PR from your last `alden queue` in the browser, by its number in that list.

## alden review

```sh
alden review [pr]
```

Briefs you on a PR, or on your uncommitted local changes when you don't name one. `pr` can be a PR URL,
`owner/repo#123`, or a number from your last `alden queue`. See [Briefings and checks](checks.md).

| Flag | What it does |
| --- | --- |
| `--no-llm` | Run only the deterministic checks, without asking a model. |
| `--no-graph` | Skip the code graph (callers outside the diff). |
| `--model <name>` | Use this model for this review, e.g. `opus`, instead of your configured one. |
| `--effort <level>` | How hard the model thinks: `low`, `medium`, `high`, `xhigh` or `max`. Default: the model's own. |
| `--json` | Print the briefing as JSON. Schema: `packages/schema/json/briefing.v1.json`. |

Local reviews cover staged, unstaged and untracked files, compared with `HEAD`.

## alden ui

Opens the queue and briefings in your browser, served on 127.0.0.1 only until you stop it. See
[The web UI](web-ui.md).

| Flag | What it does |
| --- | --- |
| `--port <n>` | Serve on this port instead of a free one. |
| `--no-open` | Print the link instead of opening a browser. |

## alden doctor

Checks your setup here: the Alden version (and whether a newer one exists), where Alden keeps files, your settings,
the GitHub sign-in and its scopes, the model and today's budget, whether this folder is a clone (and of which repo),
and which languages the code graph reads in it. Every problem comes with its fix. `--json` prints the findings as
data. Exits with 1 when something fails.

## alden stats

Shows a repo's time to first review and review cycle time, before and after Alden.

| Flag | What it does |
| --- | --- |
| `--repo <owner/name>` | The repo (default: the one this clone's `origin` points at). |
| `--days <n>` | Look at PRs opened in the last n days. Default 90. |
| `--since <date>` | Compare before and after this date (YYYY-MM-DD), instead of your first use of Alden. |
| `--horizon <days>` | Judge each wait over this many days. Default 14. |
| `--refresh` | Ignore the hour-long cache. |
| `--json` | Print the stats as JSON. Schema: `packages/schema/json/repo-stats.v1.json`. |

## alden feedback

Shows how often you agreed with Alden's flags, and what it missed. `--json` prints the summary. `--export <file>`
writes your feedback to a file you can share, with repo names, titles, paths and notes removed; add `--full` to keep
them.

## alden spend

Shows what Alden has spent on models today and over recent days, against your caps. `--json` prints the report as
data. See [Models, providers and budgets](models.md#budgets).

## alden config

Reads and changes settings. See [Configuration](configuration.md).

| Command | What it does |
| --- | --- |
| `alden config get <key>` | Prints a setting, e.g. `alden config get model.name`. |
| `alden config set <key> <value>` | Changes a setting in your user config, e.g. `alden config set budget.dailyUsd 20`. |
| `alden config unset <key>` | Removes a setting from your user config, so its default applies again, e.g. `alden config unset model.effort`. |
| `alden config list` | Prints every setting after merging the defaults, your user config and the repo's config. |
| `alden config path` | Prints the path of your user config file. |
