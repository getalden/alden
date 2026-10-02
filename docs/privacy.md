# Privacy and data

Alden runs on your machine. There is no Alden server, and nothing is sent to Alden's developers.

## What leaves your machine

| Goes to | What | When |
| --- | --- | --- |
| GitHub | API requests with your token: review requests, PR details, diffs, CI status, CODEOWNERS. Git fetches of PRs for the code graph. | `alden queue`, `alden review <pr>` |
| Your model provider | The PR's title and description, the diff, a few lines around callers outside the diff, and your [notes](memory.md#your-notes) for the repo. | `alden review`, unless `--no-llm` |

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
memory](memory.md)). See [Files Alden keeps](configuration.md#files-alden-keeps). Your GitHub token is stored in the OS keychain, or, where
there's no keychain, in a file only your user can read. `alden auth logout` removes it.

## Telemetry

Alden collects no usage data. An opt-in, anonymous option may come later, and it will be off unless you switch it on.
