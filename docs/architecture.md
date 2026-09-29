# Architecture

Alden is a TypeScript monorepo. The engine does the whole review locally; the CLI, and later the local UI and desktop
app, render its output. Deterministic analysis handles what can be proven, and the model judges on top of it.

## Packages

| Package | What it is |
| --- | --- |
| `packages/schema` | The shared formats, as zod schemas: config, ranked queue, briefing. JSON Schemas are generated into `packages/schema/json`, and a test fails when they're stale. |
| `packages/core` | The engine: config, GitHub, the queue, diffs, checks, the code graph and the model layer. |
| `packages/cli` | The `alden` command and terminal rendering. The only published package; tsup bundles `core` and `schema` into it. |
| `packages/ui` | The local web UI. A placeholder for now. |

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
   merged: deterministic high-severity picks keep their slots. The model step never throws; failures become a status
   and a note.
7. **Render.** The briefing, a plain object matching `briefing.v1`, is printed as text or JSON.

## Principles

- **Evidence for every claim.** A check that flags something says what it looked at and where.
- **Degrade, don't fail.** No token, no model, no clone, an unsupported language: the review still prints, and says
  what it couldn't do.
- **Never touch the user's work.** PR checkouts live in Alden's own worktrees. Alden posts nothing to GitHub.
- **Bounded cost and time.** Model calls are capped before they're sent; indexing has a time budget.
