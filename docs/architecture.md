# Architecture

Alden is a TypeScript monorepo. The engine does the whole review locally; the CLI, the local UI, the desktop app and
`alden mcp` render its output. Deterministic analysis handles what can be proven, and the model judges on top of it.

## Packages

| Package | What it is |
| --- | --- |
| `packages/schema` | The shared formats, as zod schemas: config, ranked queue, briefing. JSON Schemas are generated into `packages/schema/json`, and a test fails when they're stale. |
| `packages/core` | The engine: config, GitHub, the queue, diffs, checks, the code graph and the model layer. |
| `packages/cli` | The `alden` command and terminal rendering, the web UI's server (`src/ui`) and the MCP server for AI coding tools (`src/mcp`: the protocol over stdio, the tools and their Markdown output). The only published package; tsup bundles `core` and `schema` into it. |
| `packages/ui` | The web UI: React and Vite, talking only to the local API, so the desktop app can wrap it. The CLI build copies it into `dist/ui`. |
| `packages/desktop` | The macOS app: a Tauri 2 shell that runs the standalone binary as `alden ui --json` and shows it in a window and the menu bar. See its [README](../packages/desktop/README.md). |

## Inside core

| Directory | What it does |
| --- | --- |
| `github/` | Octokit client with retries and rate-limit handling, token resolution (env, keychain, `gh`), device sign-in, CODEOWNERS, PR details and the review-request search. |
| `queue/` | File classification (code, test, docs, lockfile…) and ranking into "needs you" and "fast-track". |
| `diff/` | A unified-diff parser, and diff sources: GitHub's per-file patches, and `git diff` for local changes. |
| `review/` | The checks, "needs your eyes" picking, briefing assembly, and `reviewPullRequest` / `reviewLocalChanges`. |
| `review/llm/` | The model's prompt (diff packed by priority to fit the budget), validation of its findings against the diff, and merging them into the briefing. |
| `llm/` | Model aliases and prices, providers (Anthropic, Bedrock, Vertex, Foundry, OpenAI-compatible), budgets and the spend ledger. |
| `graph/` | tree-sitter parsing and symbol extraction, the repo index and its cache, changed symbols, import resolution, caller queries, and PR worktrees. |
| `feedback/` | The feedback log (verdicts and misses), its summary, and the redacted export. |
| `learn/` | What Alden learns from one reviewer in one repo, as plain counts, and how it moves flags and queue rows. |
| `stats/` | Time to first review and cycle time for `alden stats`, and the first use of Alden per repo. |
| `store/` | The SQLite database, `~/.alden/alden.db` (`node:sqlite`, or Bun's in the standalone binary), and its migrations. |
| `telemetry/` | Opt-in usage stats: consent, the salted repo hash, the queue in the database and sending to PostHog. |

## The web UI's server

`alden ui` runs `packages/cli/src/ui/server.ts`: a `node:http` server on 127.0.0.1 that serves the built UI and a
JSON API. `api.ts` wires the API to the engine with the same calls the CLI commands make. Every API call needs the
session token and the server's own Host, and reviews stream newline-delimited JSON: a `stage` event per step (from
core's `onStage` callback), then the `briefing` or an `error`. Any path outside `/api/` serves the built UI.

| Method and path | What it does |
| --- | --- |
| `GET /api/session` | Alden's version, the folder and repo it runs in, the GitHub user (or, signed out, why: the keychain refused or there's no sign-in), the model and where its key comes from, the budget, and whether it's the desktop app and background briefings are on. |
| `GET /api/queue` | The ranked queue. `refresh=1` skips the cache; `repo` and `org` (repeatable) narrow it. |
| `POST /api/review` | Runs a review of `{ pr?, llm?, graph?, model?, effort? }` and streams it as above. No `pr` reviews local changes. |
| `POST /api/prepare` | Briefs the next of the top three PRs in the background. Acts only when started with `--json` (the desktop app) and `background.enabled` is on; asks the model only if `background.model` is true in the user config. |
| `GET /api/prepared` | Briefings prepared in the background; with `pr=owner/repo#12`, that PR's briefing, unless the PR changed since. |
| `GET /api/spend` | Today's and recent spend against your caps. |
| `GET /api/config` | The merged settings. |
| `PUT /api/config` | Sets `{ key, value }` in the user config; a `null` value removes it. |
| `GET /api/stats` | `alden stats` for `repo`, over `days` (90), split at `since`; `refresh=1` skips the cache. |
| `GET /api/feedback` | The feedback summary. |
| `POST /api/feedback` | Records a verdict on a flag, or a miss. |
| `GET /api/feedback/export` | Your feedback, always redacted (see [Privacy and data](privacy.md#sharing-your-feedback)). |
| `POST /api/reaction` | Records `{ pr, reaction }` (`up`, `down`, `dismiss` or `clear`) on a row of the last queue. |
| `GET /api/memory` | What Alden knows about you in `repo` (default: the clone it runs in). |
| `POST /api/memory` | Adds a note: `{ text, repo? }`. |
| `GET /api/memory/repos` | Each repo Alden has memory for. |
| `POST /api/memory/change` | `{ action, repo? }`: `edit` (with `id`, `text`), `restore` (with `id`), `learning` (with `on`) or `forget-all`. |
| `POST /api/memory/forget` | Forgets one item: `{ id, repo? }`. |
| `GET /api/drafts` | `pr=owner/repo#12`'s pending review: `{ drafts, unaddressed }`, the drafts brought to the PR's current head (moved with their lines, or `outdated`), and the places its latest briefing flagged that no draft is near. |
| `POST /api/drafts` | Adds a draft at the PR's head: `{ pr, path?, line?, side?, body }`; without `path` and `line`, a general note. Always yours (`source: "you"`). 422 when the line isn't in the diff. |
| `PATCH /api/drafts/:id` | Changes a draft's `{ body }`, or places it on a line again with `{ path, line, side? }`, which brings an outdated draft back. |
| `DELETE /api/drafts/:id` | Deletes a draft: `{ ok: true }`. |
| `POST /api/review/send` | Sends the PR's drafts to GitHub as one review: `{ pr, event: COMMENT \| APPROVE \| REQUEST_CHANGES, body? }` → `{ url, posted, review }`. The only route that writes to GitHub. Refuses (409) when a draft is outdated or the PR moved since the drafts were listed, 422 when a line isn't in the diff, 403 with the fix when the sign-in can't write reviews. Sent drafts are deleted. |
| `POST /api/auth/device` | Starts GitHub sign-in with a one-time code (the device flow); the server waits for approval. |
| `GET /api/auth/device` | How that sign-in is going: waiting (with the code), done, or failed. |
| `POST /api/auth/device/open` | Opens GitHub's page for the code in the default browser. |
| `POST /api/auth/gh` | Drops Alden's stored sign-in, so it uses the GitHub CLI's. |
| `PUT /api/model-key` | Stores `{ key }` (the Anthropic API key) in the keychain, as `alden auth model` does; `null` removes it. Write-only: answers where the key comes from, never the key. |
| `GET /api/model-setup` | What "Set up a model" offers: what reviews use now, any Anthropic key Alden finds (where from, never the key), whether Ollama runs and what it has pulled, this machine's memory and the local model recommended for it. |
| `POST /api/model-setup/test-key` | Tests `{ key }` with one tiny request (Haiku, one output token) and stores it if it works, making Claude the model; `untested: true` stores it without the request. Answers `{ ok, key }` or `{ ok: false, reason, message }`, never the key. |
| `POST /api/model-setup/local` | Makes `{ model }` (an Ollama model name) the model, pulling it first if Ollama hasn't; streams `progress` lines, then `done` or `error`, as a review does. Closing the request stops the download. |
| `POST /api/model-setup/open` | Opens one of the setup step's pages (`keys`, `cloud` or `ollama`) in the default browser, for the desktop window. Only those three. |
| `GET /api/clone` | The local clone PR briefings on `repo` find callers in (here, remembered, or under `clones.folders`), or null. |
| `GET /api/cli` | Desktop app: whether the `alden` command is installed, and where. |
| `POST /api/cli/install` | Desktop app: links its `alden` into `/usr/local/bin` (macOS may ask for a password). |
| `GET /api/telemetry` | Whether usage stats are on, and what blocks them, if anything. |
| `PUT /api/telemetry` | Turns usage stats on or off: `{ on }`. |

## How a review flows

1. **Target.** A PR (URL, `owner/repo#n`, or a queue number) or the local working tree.
2. **Diff.** Fetched from GitHub or read from git, then parsed into files, hunks and lines.
3. **Code graph** (unless `--no-graph`). The repo is indexed from the working tree or a PR worktree. Changed lines are
   mapped to symbols, and the callers of changed public symbols are found. Failures become a "Not checked" note.
4. **Checks.** Each check gets the diff, PR details and graph, and returns passed, flagged or skipped, with evidence.
5. **Pick.** Up to 3 "needs your eyes" places are chosen from the flagged checks.
6. **Model** (unless `--no-llm` or unconfigured). The prompt is built from the diff, the check results and caller
   snippets, and sized to the budget. `budgetedGenerate` is the only way to call a model: it checks the worst-case
   cost against both caps, then records the actual cost in the ledger. Findings are checked against the diff, then
   merged: deterministic high and critical picks keep their slots. The model step never throws; failures become a status
   and a note.
7. **Render.** The briefing, a plain object matching `briefing.v1`, is printed as text or JSON.

## Principles

- **Evidence for every claim.** A check that flags something says what it looked at and where.
- **Degrade, don't fail.** No token, no model, no clone, an unsupported language: the review still prints, and says
  what it couldn't do.
- **Never touch the user's work.** PR checkouts live in Alden's own worktrees. Alden posts only what you send: one review, on your click or command.
- **Bounded cost and time.** Model calls are capped before they're sent; indexing has a time budget.
