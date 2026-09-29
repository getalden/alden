# Troubleshooting

## GitHub

**"Bad credentials" or "GitHub rejected the token".** The token Alden is using was revoked or expired. Run
`alden auth status` to see where it comes from:

- From `ALDEN_GITHUB_TOKEN`: fix or unset the variable.
- Stored by Alden: run `alden auth login --device`.
- From the GitHub CLI: run `gh auth login`.

**Team review requests are missing.** The token needs the `read:org` scope. `alden auth status` lists the token's
scopes. Sign in again with `alden auth login --device`, or run `gh auth refresh -s read:org`.

**Private repos are missing.** The token needs the `repo` scope, and your organisation may need to approve Alden's
OAuth app. Check your organisation's third-party access settings on GitHub.

## Models

**"No Anthropic API key found, so only the checks ran."** Set `ANTHROPIC_API_KEY`, run `ant auth login`, or pass
`--no-llm` to hide the note.

**"Couldn't find Google Cloud credentials for Vertex."** Run `gcloud auth application-default login`, or set
`GOOGLE_APPLICATION_CREDENTIALS` to a service account key file. Also set `model.projectId`.

**"model.name is a Claude model, but the provider is openai-compatible."** Set your local model's name, e.g.
`alden config set model.name qwen3-coder:30b`.

**"Over budget."** The review would exceed `budget.perReviewUsd` or what's left of `budget.dailyUsd`. `alden spend`
shows where you are. Raise a cap, lower effort, or use a cheaper model with `--model haiku`.

**Reviews are slow.** Model reviews at high effort can take a minute. Try `--effort medium` or `--effort low`. The
deterministic checks don't depend on the model.

## Code graph

**"Run `alden review` from a clone of owner/repo to check callers outside the diff."** For PR reviews, Alden needs a
clone of the PR's repo. `cd` into one and run the review again. See [Reviewing PRs](code-graph.md#reviewing-prs).

**"This clone has no remote for owner/repo."** None of the clone's remotes point at the PR's repo. Add one, e.g.
`git remote add upstream https://github.com/owner/repo`.

**"The index was cut short, so there may be more."** Indexing hit its 60-second limit. Run the review again: the
parsed files are cached, so the next run gets further.

**A stale PR worktree.** Delete `~/.alden/worktrees` and run `git worktree prune` in your clone. Alden recreates the
worktree next time.

## macOS

**"EPERM: operation not permitted, uv_cwd".** Your terminal app isn't allowed to read the folder you're in, usually
Desktop, Documents or Downloads. Allow it in System Settings → Privacy & Security → Files and Folders, or run Alden
from another terminal or folder.
