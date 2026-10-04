# Privacy and data

Alden runs on your machine. There is no Alden server, and nothing is sent to Alden's developers unless you opt in to
[anonymous usage stats](telemetry.md).

## What leaves your machine

| Goes to | What | When |
| --- | --- | --- |
| GitHub | API requests with your token: review requests, PR details, diffs, CI status, CODEOWNERS. Git fetches of PRs for the code graph. | `alden queue`, `alden review <pr>`, `alden stats`, `alden ui`, the desktop app, `alden mcp` |
| PostHog (EU), only if you said yes | Anonymous usage stats: see [Usage stats](telemetry.md) | After each command; every minute while `alden ui` runs |
| Your model provider | The PR's title and description, the diff, a few lines around callers outside the diff, and your [notes](memory.md#your-notes) for the repo. | `alden review`, unless `--no-llm` |
| Your AI coding tool, through `alden mcp` | Queue rows, briefings including PR text and code, and your notes. From there they reach that tool's model provider. | When the tool calls Alden's tools |
| The npm registry | A request for Alden's newest version. Nothing about you or your repos. | `alden --version` and `alden doctor`, at most once a day; off with `updates.check false` or `ALDEN_NO_UPDATE_CHECK` |

Nothing goes to a model when no provider is configured or you pass `--no-llm`. With a local model (Ollama, LM Studio),
nothing leaves your machine at all.

**Likely secrets are hidden from the model.** Before the prompt is sent, Alden replaces anything that looks like a
credential with a placeholder that keeps only its kind and length, e.g. `[redacted GitHub token, ghp_…(44 chars)]`.
That covers the diff, the PR description and the caller snippets. It uses the same detection as the "Likely secrets"
check: known key formats, private keys (the whole key body), passwords in connection strings, and random-looking
values assigned to secret-like names. The briefing's footer says how many were hidden.

Detection is heuristic, so a secret in an unusual shape can still get through. Use `--no-llm` for changes you know
contain credentials, and rotate any secret that was committed: it's in the branch history even if the model never saw
it.

What happens to data at your model provider is governed by your agreement with them. Anthropic's API doesn't train on
API data by default.

## What stays on your machine

Feedback, the PRs you open and what Alden learns from them stay in `~/.alden/alden.db` ([Learning and
memory](memory.md)). So do your notes, what you've spent on models, usage stats waiting to be sent (only if you said
yes), and this install's anonymous id and the salt for repo hashes. Checkouts of PRs for the code graph are in
`~/.alden/worktrees`. See [Files Alden keeps](configuration.md#files-alden-keeps). Your GitHub token is stored in the
OS keychain, or, where there's no keychain, in a file only your user can read. `alden auth logout` removes it. So is an
Anthropic API key you stored with `alden auth model`; `alden auth model --remove` removes it.

The desktop app's [background briefings](desktop.md#while-youre-away) make the same GitHub calls as a review while
you're away, and ask your model provider only if you turned on `background.model`. The briefings are held only in the
running server's memory, and are gone when you quit.

## Sharing your feedback

`alden feedback --export <file>` writes your feedback to a file you can share, for example with Alden's developers.
It replaces repo names with a hash salted with a value that never leaves your machine, and each flag's title with a
code salted fresh for each export, and drops paths, lines and notes. PR numbers, check ids, verdicts, times and the
model stay. `--full` keeps everything. Settings → Your feedback in `alden ui` always exports redacted.

## Usage stats

Off unless you say yes. With your OK, Alden sends anonymous usage stats (which commands and views you use, review
counts and timings, which way your feedback points) to PostHog in the EU. Never code, titles, paths, repo or user
names. See [Usage stats](telemetry.md) for every event and how to turn it off.
