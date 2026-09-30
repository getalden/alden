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

The phase 1 test is whether a briefing flags the code that later broke. The `reg-*` fixtures are PRs in all four
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
