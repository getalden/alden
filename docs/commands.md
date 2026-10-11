# Commands

Run `alden <command> --help` for the same information in your terminal.

In a terminal, `alden queue`, `alden review` and `alden doctor` end with a dim "Next:" line suggesting the obvious next
command: `alden review 1` for the top of the queue, `alden open <#>` or `alden ui` after a review, the fix `doctor`
found. It never appears with `--json` or when the output goes to a pipe or a file.

## alden --version

Prints Alden's version. When a newer Alden is out, it also says so, with how to upgrade, on standard error so scripts
reading the version aren't affected. It asks npm at most once a day; `alden config set updates.check false` or
`ALDEN_NO_UPDATE_CHECK` turns this off. `alden doctor` reports the same.

## alden setup

Sets up a model in about a minute. In a terminal it asks which of three you want:

1. **Paste an Anthropic API key.** It links to where you create one, reads it without showing it, checks it with one
   tiny request (Claude Haiku, one output token: a fraction of a cent), and stores it as `alden auth model` does. A key
   Anthropic refuses isn't stored, and it says why: mistyped or deleted, no credit, or no permission. When Anthropic
   can't be reached, it offers to store the key unchecked. If your config used another provider, Claude becomes the
   model again.
2. **Use a local model.** Looks for Ollama (at `OLLAMA_HOST`, or `http://localhost:11434`), lists what it has pulled,
   and recommends a model for your machine's memory (see [Models](models.md#local-and-openai-compatible-models-openai-compatible)).
   Choosing one it hasn't pulled downloads it with progress; then it sets `model.provider`, `model.name` and, when
   Ollama isn't at its default address, `model.baseUrl`.
3. **Checks only.** Changes nothing.

Outside a terminal (a pipe, a script), it prints what it would offer and the commands to do each by hand, and exits
with 0. In a terminal, it exits with 1 when no model was set up (except for checks only). `alden doctor` suggests it when there's no model.

## alden auth

Sign in to GitHub, and store your Anthropic API key.

| Command | What it does |
| --- | --- |
| `alden auth login` | Uses the GitHub CLI's sign-in if there is one. Otherwise signs you in with a code in your browser and stores the token. |
| `alden auth login --device` | Signs in with a one-time code, even if the GitHub CLI is signed in. Press Enter to open the GitHub page for it. |
| `alden auth login --with-token` | Reads a token from standard input, e.g. `echo $TOKEN \| alden auth login --with-token`. |
| `alden auth status` | Shows the account Alden is using, where the token comes from, and its scopes; and where the Anthropic key comes from (never the key). Signed out, it says whether the keychain refused to answer. |
| `alden auth logout` | Removes the token Alden stored. Doesn't touch the GitHub CLI's sign-in. |
| `alden auth model` | Asks for your Anthropic API key without showing it (or reads it from standard input, e.g. `pbpaste \| alden auth model`), checks it looks like an API key, and stores it in the OS keychain. The desktop app, `alden ui` and `alden mcp` use it too. `alden setup` does the same after checking the key works. |
| `alden auth model --remove` | Removes the key Alden stored. |

Alden looks for a token in this order:

1. The `ALDEN_GITHUB_TOKEN` environment variable.
2. The token Alden stored, in the OS keychain (or, where there's no keychain, a file only you can read).
3. The GitHub CLI's token (`gh auth token`).

For the model key's order, see [Models](models.md#anthropic-api-anthropic-the-default).

## alden queue

Ranks the open PRs waiting on your review, within what your queue covers on this machine (`queue.orgs`, `queue.repos`
and `queue.ignore`; see [Configuration](configuration.md#queue)). See [The review queue](queue.md).

While it works, a spinner on standard error says what it's doing ("Checking acme/shop (2 of 5)…"). It shows only in a
terminal, and never on standard output, so scripts reading the queue get only the queue.

| Flag | What it does |
| --- | --- |
| `--repo <owner/name>` | Only this repo, instead of your queue settings for this run. Repeat for more. |
| `--org <name>` | Only repos in this organisation, instead of your queue settings for this run. Repeat for more. |
| `--limit <n>` | The most PRs to fetch. Default 100. |
| `--include-drafts` | Include draft PRs. Each is tagged `[Draft]` before its title and dimmed. |
| `--refresh` | Ignore the 60-second cache. |
| `--author <who>` | Only PRs by this login, or by `people`, `bots`, `agents` (AI agents) or `you`. |
| `--label <name>` | Only PRs with this label (any case). |
| `--search <text>` | Only PRs whose title, repo, `#number`, author or branch names contain every word. |
| `--sort <order>` | `rank` (the default), `age` (open longest first), `waiting` (waited on you longest first), `updated` (most recent first) or `size` (smallest first). Sorts inside Needs you and Fast-track separately. |
| `--json` | Print the ranked queue as JSON. Schema: `packages/schema/json/ranked-queue.v1.json`. With the flags above, only what they leave. |
| `--explain` | Under each row, its score by weight and rule, named as `[queue.rank]` names them: `score 6: waiting +3 · risk +2 · ↑ your rule: payments/ first`. See [Your ranking](queue.md#your-ranking). |

With `--author`, `--label`, `--search` or `--sort`, a line above the table says what's shown ("12 of 144 PRs: label
db"), and `alden open` and `alden review` take the numbers as shown.

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
| `--markdown` | Print the briefing as a Markdown document to share or keep: `alden review 12 --markdown > briefing.md`. |

Local reviews cover staged, unstaged and untracked files, compared with `HEAD`.

`--markdown` writes the briefing as a document for people: the PR's title, `owner/repo#123` with its link, what it
does (when the model ran), "Needs your eyes" with each file and line and why, the model's other findings, callers
outside the diff, every check with its evidence, what wasn't checked, the files, and a closing line with the model, its
cost and when it was briefed. It's the same document as **Export → Copy as Markdown** in the [web UI](web-ui.md). Your
memory notes and what your feedback changed stay out of it; secrets stay masked as the checks recorded them; terminal
control sequences are removed. For example:

```markdown
# Drop the legacy email column

[acme/shop#412](https://github.com/acme/shop/pull/412) by @sam · main ← sam/drop-email  
3 files · +48/-12

## Needs your eyes
1. **Migration may lose data** (critical) `db/migrate/0042_drop_email.ts:4`
   Dropping a column can't be undone.

## Checked
- ! **Migration may lose data** (critical): A column is dropped.
  - `db/migrate/0042_drop_email.ts:4` drops users.email
- ✓ **Code changed without tests** (inferred from the diff, can be wrong): Tests changed alongside the code.

…

---

Checks only, no model · briefed 2026-10-06 09:30 UTC by Alden
```

## alden comment

```sh
alden comment <pr> [file:line[-endLine]] "text" [--suggest "code" | --suggest-file <path> | --suggest -]
alden comment <pr> --threads
alden comment <pr> --reply <thread> "text" [--resolve]
alden comment <pr> --resolve <thread>
```

Writes a comment on a PR, kept in Alden until you send it with `alden send`. With `file:line`, it's on that line of
the diff, and with `file:12-14` on lines 12 to 14 (one hunk, one side); without, it's a general note for the review's
body. A line (or lines) outside the PR's diff, where GitHub won't take an inline comment, becomes a general note that
links to it at the PR's head, and Alden says so ("py/orders/tasks.py:5 isn't in the PR's diff, so this goes in the
review body with a link to it"); the file and line must exist at the head. See
[Comments on code outside the diff](comments.md#comments-on-code-outside-the-diff). With a suggestion, it's a suggested change the author can apply on GitHub, and the text is optional. With no
text, lists the PR's comments, ranges and suggestions (old lines and new) shown, outdated ones marked. `pr` takes the same forms as `alden review`. See [Comments and sending a review](comments.md).

| Flag | What it does |
| --- | --- |
| `--left` | The line numbers are in the old file: a comment on removed lines. Not with a suggestion. |
| `--suggest <code>` | Suggests replacement code for the line(s), exactly as they should read. `-` reads it from stdin; `""` deletes the lines. See [Suggesting changes](comments.md#suggesting-changes). |
| `--suggest-file <path>` | Suggests the replacement code in this file. From a file or stdin, one trailing newline is dropped. |
| `--delete <id>` | Deletes a comment (or a reply), by the id the list shows. On one of [Alden's drafts](comments.md#aldens-drafts), drops it. |
| `--keep <id>` | Keeps one of Alden's drafts (or `all` of them on the PR), making it yours so it's sent with your review. |
| `--threads` | Lists the PR's review threads, yours first and open ones first, each with a short id and every comment. |
| `--reply <thread>` | Replies in a review thread already on the PR, by its short id or `file:line`, with your review. One reply per thread: again changes its text. See [Replying in a thread](comments.md#replying-in-a-thread). |
| `--resolve [thread]` | With `--reply`, resolves the thread once your review is sent. Alone, names the thread to resolve, saying nothing. |
| `--json` | Print the comments (or the new one, or with `--threads` the threads) as JSON. Schema: `packages/schema/json/review-draft.v1.json`. |

## alden send

```sh
alden send <pr> --comment | --approve | --request-changes [-m body]
```

Sends the PR's comments to GitHub as one review. First it shows exactly what will post (the body, then each comment
with its file and line or lines, each suggestion as the lines it replaces and the lines it suggests, each reply in its
thread and whether it resolves it, and before an approval the places Alden flagged that you didn't comment on), then
asks. Replies post into the review before it's submitted; threads are resolved after (see
[How a review with replies is sent](comments.md#how-a-review-with-replies-is-sent)). Nothing
else in Alden posts to GitHub. Alden's drafts you haven't kept aren't sent, and it says how many; like every draft on the PR, they're cleared once the review is sent. See [Comments and sending a review](comments.md#sending).

| Flag | What it does |
| --- | --- |
| `--comment`, `--approve`, `--request-changes` | What the review does. Exactly one. |
| `-m, --message <body>` | The review's body. General notes follow it. |
| `-y, --yes` | Send without asking. Without a terminal to ask on, Alden won't send unless you pass it. |

## alden watch

```sh
alden watch [pr] [--off | --rereview | --your-turn | --every-reply | --default]
```

How much the desktop app tells you about a PR after you review it: its own level, overriding
`notifications.followUps` until the PR is merged or closed. With a level, sets it; `--default` puts the PR back on the
global level; with neither, says which level applies. Without a PR, lists the PRs with their own level. `pr` takes the
same forms as `alden review`. See [Follow-ups on PRs you reviewed](desktop.md#follow-ups-on-prs-you-reviewed).

| Flag | What it does |
| --- | --- |
| `--off` | No notifications about this PR. |
| `--rereview` | Only when you're asked to review it again. |
| `--your-turn` | A re-review, or when every comment you left is resolved or answered. |
| `--every-reply` | Each reply, resolve and re-review, and a push that makes one of your comments outdated. |
| `--default` | Back to the global level. |
| `--json` | Print the PR's level (`{ pr, override?, level }`), or the global level and the list, as JSON. |

## alden ui

Opens the queue and briefings in your browser, served on 127.0.0.1 only until you stop it. See
[Alden in your browser](web-ui.md).

| Flag | What it does |
| --- | --- |
| `--port <n>` | Serve on this port instead of a free one. |
| `--no-open` | Print the link instead of opening a browser. |
| `--json` | Print one JSON line with the link and port, and don't open a browser. The desktop app uses it, and it turns on background briefings. |

## alden mcp

Serves Alden to an AI coding tool (Claude Code, Cursor, Claude Desktop and others) as MCP tools over stdio, until the
tool closes it. See [Alden in your AI coding tool](mcp.md).

| Flag | What it does |
| --- | --- |
| `--dir <path>` | The clone to review local changes and find callers in, instead of the folder it was started in. |

## alden doctor

Checks your setup here: the Alden version (and whether a newer one exists), where Alden keeps files, your settings,
the GitHub sign-in and its scopes (and whether it can post the reviews you send), which of your organisations' PRs it
can see (and why not, for any that hide them), the model and today's budget, whether this folder is a clone (and of
which repo), and which languages the code graph reads in it. Every problem comes with its fix. `--json` prints the
findings as data. Exits with 1 when something fails. With no model, its "Next:" line suggests `alden setup` as well as
the first fix.

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

Shows how often you found Alden's flags useful, and what it missed, then where each lesson stands in every repo you've
given feedback in ("2 of 3: one more not useful on API change flags and Alden will quieten them"). `--json` prints the
summary only.

`--export <file>` writes your feedback to a file you can share. Repo names become a hash salted with a value that never
leaves your machine (the same one [usage stats](telemetry.md) use), and each flag's title becomes a code salted fresh
for that export. Paths, lines and notes are dropped. PR numbers, check ids, verdicts, times and the model stay. Add
`--full` to keep everything.

## alden memory

Lists what Alden has learned about you in a repo, and your notes for it: by default the repo of the clone you're in,
or `--repo owner/name`. `--json` prints the items. Every subcommand also takes `--repo owner/name`. See
[Learning and memory](memory.md).

| Command | What it does |
| --- | --- |
| `alden memory add <text>` | Adds a note; the model gets it with every review of the repo. |
| `alden memory edit <id> <text>` | Changes a note's text. |
| `alden memory exclude <id> <path>` | Stops applying a note to a folder (`app/api`) or file. `alden memory` lists where each note is stopped. |
| `alden memory include <id> <path>` | Applies a note there again. |
| `alden memory forget <id>` | Forgets a note or a learned item, by the id `alden memory` shows. |
| `alden memory forget --all` | Forgets everything in this repo. |
| `alden memory restore <id>` | Takes back a forget. |
| `alden memory pause` / `resume` | Stops or restarts applying what Alden learned here. Your reactions are still saved, and notes still apply. |

## alden telemetry

Anonymous usage stats, off unless you say yes. `alden telemetry` says whether they're on; `on` and `off` change it
(`off` also deletes anything not yet sent); `show` prints what's waiting to be sent. See [Usage stats](telemetry.md).

## alden spend

Shows what Alden has spent on models today and over recent days, against your caps. `--json` prints the report as
data. See [Models, providers and budgets](models.md#budgets).

## alden completion

```sh
alden completion zsh|bash|fish
```

Prints a tab-completion script for your shell, covering every command and flag. Install it with:

| Shell | Command |
| --- | --- |
| zsh | `alden completion zsh > "${fpath[1]}/_alden"`, then start a new shell. Or add `eval "$(alden completion zsh)"` to `~/.zshrc`, after `compinit`. |
| bash | `alden completion bash > ~/.local/share/bash-completion/completions/alden`. Or add `eval "$(alden completion bash)"` to `~/.bashrc`. |
| fish | `alden completion fish > ~/.config/fish/completions/alden.fish` |

Run it again after upgrading Alden, so new commands and flags complete too.

## alden config

Reads and changes settings. See [Configuration](configuration.md).

| Command | What it does |
| --- | --- |
| `alden config get <key>` | Prints a setting, e.g. `alden config get model.name`. |
| `alden config set <key> <value>` | Changes a setting in your user config, e.g. `alden config set budget.dailyUsd 20`. |
| `alden config unset <key>` | Removes a setting from your user config, so its default applies again, e.g. `alden config unset model.effort`. |
| `alden config list` | Prints every setting after merging the defaults, your user config and the repo's config. |
| `alden config path` | Prints the path of your user config file. |
