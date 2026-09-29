# Evals

Prompt and model changes are measured against recorded public PRs before they ship.

## Running

```sh
pnpm eval                                  # prints what a run would cost; calls nothing
pnpm eval --yes                            # runs every recorded PR through the model review
pnpm eval --yes --model opus --effort medium
pnpm eval --yes --only django              # one recorded PR
pnpm eval --yes --clones ~/src             # with the code graph, from clones in ~/src/<name>
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

With labels, from `eval/expectations.json`:

- `mustFlag`: a "needs your eyes" item or model finding must point at this path (and line, if given).
- `maxSlotsOnGlob`: at most this many slots may land on files matching a glob.

When Alden misses something that mattered in real use, add it to `expectations.json` so the next change is measured
against it.

## The recorded PRs

`pnpm fixtures:record` records GitHub responses (PR details, descriptions and diffs) for a pinned list of public PRs
into `packages/core/src/github/__fixtures__`. The PR numbers are pinned so results stay comparable over time. The same
fixtures drive the unit tests.
