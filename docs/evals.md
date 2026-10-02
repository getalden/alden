# Evals

Prompt and model changes are measured against recorded public PRs before they ship.

## Running

```sh
pnpm eval                                  # prints what a run would cost; calls nothing
pnpm eval --yes                            # runs every recorded PR through the model review
pnpm eval --yes --model opus --effort medium
pnpm eval --yes --only django              # one recorded PR
pnpm eval --yes --clones ~/src             # with the code graph, from clones in ~/src/<name>
pnpm eval --no-llm                         # the checks and code graph alone: free, no key needed
pnpm eval --no-llm --only reg              # just the regression cases
```

With `--yes`, the eval uses your configured provider and spends against your caps and ledger like any review. Results
are written to `eval/results/<time>-<model>.json`, which is gitignored.

`--clones <dir>` gives recorded PRs the code graph when their repo is cloned at `<dir>/<name>` (for example
`~/src/django`), as a real review from a clone would.

## What it measures

Without any labels:

- **Usable rate**: reviews that returned a valid answer.
- **Dropped findings**: findings pointing outside the diff. It should stay at 0.
- **Cost and time** per review.
- **Verdicts**: whether the change matches its title.

## Regressions: did the briefing point at what broke?

The test that matters most is whether a briefing flags the code that later broke. The `reg-*` fixtures are PRs in all four
languages that a later PR had to fix (Next.js for TypeScript, Django for Python, the GitHub CLI and Prometheus for Go,
Laravel for PHP). Each one's expectation names the files the fix changed, and the eval reports, overall and by
language:

- **In eyes:** the share of those files among the briefing's "needs your eyes" places.
- **Flagged:** the share that any flagged check or model finding pointed at.

`pnpm regressions:find owner/repo` finds more candidates: merged PRs that mention a regression, traced back through
`#123`, PR links or commit SHAs to the PR that caused it, keeping pairs where the fix changed the original's code.
Pick the clear ones, add them to `scripts/record-fixtures.ts`, record them with `pnpm fixtures:record --only <name>`,
and add their expectations.

The first run, checks only without clones (30 Sep 2026), pointed at 2 of 29 broken files; with Laravel's clone, the
graph added one more. The deterministic checks look for tests, migrations, config and secrets, not at the logic that
broke, so this is the baseline the model has to improve on.

With labels, from `eval/expectations.json`:

- `mustFlag`: a "needs your eyes" item or model finding must point at this path (and line, if given).
- `maxSlotsOnGlob`: at most this many slots may land on files matching a glob.

When Alden misses something that mattered in real use, add it to `expectations.json` so the next change is measured
against it.

## The recorded PRs

`pnpm fixtures:record` records GitHub responses (PR details, descriptions and diffs) for a pinned list of public PRs
into `packages/core/src/github/__fixtures__`. The PR numbers are pinned so results stay comparable over time. The same
fixtures drive the unit tests.

## The gate

Design partners send their `alden feedback --export` files each week. Put them in `eval/partners/` (gitignored: it's
their data), one file per team, named after the team (`acme.json`), then:

```sh
pnpm gate eval/partners        # each team, then whether the gate is met
pnpm gate eval/partners --md   # the same as a Markdown table
```

The gate is 10 teams using Alden weekly, and reviewers finding more than half of the "needs your eyes" flags useful. A
team counts as active when it gave feedback in the 7 days before its export. The rate pools every team's verdicts on
"needs your eyes", from each export's own summary, which is made before redaction, so it's exact. With
`POSTHOG_PERSONAL_API_KEY` set, the gate also reads the last 7 days' active installs and useful rate from
[usage stats](telemetry.md), for installs that opted in.

## End-to-end test kit

Scripts that open real test PRs in a GitHub repo and check that Alden ranks and briefs each one as expected.

```sh
pnpm e2e:sandbox <dir> --owner <login>
pnpm e2e:seed --repo owner/name --clone <path> [--base alden-e2e] [--from main] [--reviewer login] [--team org/slug]
pnpm e2e:seed --repo owner/name --clone <path> --dry-run
pnpm e2e:seed --repo owner/name --clone <path> --cleanup [--all]
pnpm e2e:verify --repo owner/name --clone <path> [--only id,id]
```

- **`e2e:sandbox`** writes the sandbox repo: a small shop in TypeScript, Python, Go and PHP, built to give every check
  something to find, with CODEOWNERS (`--owner` owns `py/`) and a CI workflow that passes in seconds unless a PR adds
  `ci/FAIL`. It lives at `getalden/alden-e2e-sandbox`; the script is how it was made, so it can be made again.
- **`e2e:seed`** opens one PR per scenario (a migration, a dependency bump, a public signature change, a stacked PR, a
  conflict and so on; scenarios that don't fit the repo are skipped) and requests your review. GitHub won't let you
  request your own review, so the PRs come from a second account: set `ALDEN_E2E_AUTHOR_TOKEN` to that account's
  classic token, with the `repo` and `workflow` scopes, and give the account write access to the repo. The PRs go to a
  base branch of their own (`--base`, default `alden-e2e`, made from `--from`), so the repo's CI stays quiet and main
  never sees them. Branches are made in a temporary worktree of `--clone`, so your working copy isn't touched.
  `--reviewer` defaults to the GitHub CLI's account; `--team` is the team asked to review the team scenario.
  `--dry-run` shows what it would open; `--cleanup` closes the PRs and deletes their branches, and `--all` deletes the
  base branch too. `--only id,id` limits it to some scenarios.
- **`e2e:verify`** runs as you, the reviewer. It ranks your queue for the repo (without your learned preferences) and
  briefs each test PR with the checks and the code graph, no model, so it's free. It compares the lane, the queue's
  reasons and the flagged checks with what each scenario expects, lists what a script can't judge for you to look at by
  hand, and exits non-zero on any failure.

The seed's list of PRs and their expectations, and verify's results, are written to `eval/e2e/` (gitignored).
