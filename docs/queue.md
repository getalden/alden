# The review queue

`alden queue` finds the open PRs that request a review from you, or from a team you're on, and ranks them. It only
orders the queue. It never approves, comments on or changes anything on GitHub.

## Which PRs are included

Open, non-archived PRs where your review is requested, directly or through a team. Each row shows which one. Drafts are
left out unless you pass `--include-drafts` or set `queue.includeDrafts`; then each is tagged Draft before its title.
Narrow the queue with `--repo` and `--org`.

## Needs you

Ranked by three factors, in this order of weight. **Blocking beats waiting beats risk.**

1. **Blocking.** The PR has an urgent or hotfix label, another PR is stacked on it, or its author has several PRs
   waiting on you. Bots (such as Dependabot) don't get the "author waiting" boost.
2. **Waiting.** How long ago your review was requested, or how long the PR has been open when GitHub didn't record the
   request. It's the one waiting time every surface shows: the terminal's Waiting column, the UI's row and the
   assistant's queue ("waiting 7h since you were asked").
3. **Risk.**
   - Size. Lockfiles don't count.
   - Sensitive paths, such as migrations, auth, payments, infrastructure, CI config and lockfiles. See
     [`queue.sensitivePaths`](configuration.md#queue).
   - Code changed without test changes.
   - Files CODEOWNERS assigns to you.
   - A major dependency bump, for example `major bump: nesbot/carbon 3 → 4`: a breaking upgrade can be a one-line
     diff. See below.

Every row gives its reasons, for example `waiting 3d · touches migrations/ · no tests`.

**Failing CI sinks a PR.** When a PR's CI is failing, the author has to act before you do, so it drops to the bottom
with `CI failing: ping @author`.

## Fast-track

A PR is fast-tracked when all of these hold:

- It's small: under 50 changed lines by default (`queue.fastTrackMaxLines`), not counting lockfiles.
- CI passed, it has no merge conflicts, and it isn't a draft.
- It only touches docs, only touches tests, or only bumps a dependency's patch version.

In a repo with no CI, only docs-only PRs qualify, because nothing has built or tested the others.

Fast-track means "you can probably clear this quickly". It's still your review.

## Major dependency bumps

When a PR changes a dependency manifest (`package.json`, `composer.json`, `go.mod`, `pyproject.toml`,
`requirements*.txt` or `Cargo.toml`), Alden reads just those files, as they are on the base branch and at the PR's
head, in one small request per PR. A dependency whose major version goes up (or whose minor version does, below 1.0,
where semver counts that as breaking) adds risk and a reason. Only upgrades count: a PR branch that's behind its base
can otherwise look like a downgrade. Go modules that move to a new `/vN` path count as a bump. The result is
remembered by the PR's head commit, so a PR is only read again after a new push. A major bump is never fast-tracked.

Nothing else in the diff is read for the queue; briefings read the whole diff.

## Speed and caching

A fresh queue is one search for the PRs' ids, then their details in parallel batches, alongside CODEOWNERS (one
lookup per repo and base commit, remembered for a week) and the stacked-PR counts. Paging through every PR's full
details one page at a time is what made a large queue slow.

Results are cached in `~/.alden/cache`. `alden queue` uses a queue up to 60 seconds old; `--refresh` skips it. The
web UI and the desktop app's window keep the last queue for a day: they show it at once, marked "As of 3 min ago, refreshing…",
and swap in the current one when it arrives.

To see where a fresh queue's time goes, set `ALDEN_DEBUG=queue`:

```sh
ALDEN_DEBUG=queue alden queue --refresh
```

It prints each step (viewer, search, details, CODEOWNERS, stacked PRs, manifests) with its time and number of
requests to stderr. The steps overlap, so their times add up to more than the total.

## JSON

`--json` prints the ranked queue in the format described by `packages/schema/json/ranked-queue.v1.json`, for scripts
and other tools.
