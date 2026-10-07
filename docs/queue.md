# The review queue

`alden queue` finds the open PRs that request a review from you, or from a team you're on, and ranks them. It only
orders the queue. It never approves, comments on or changes anything on GitHub.

## Which PRs are included

Open, non-archived PRs where your review is requested, directly or through a team. Each row shows which one. Drafts are
left out unless you pass `--include-drafts` or set `queue.includeDrafts`; then each is tagged Draft before its title.
Narrow the queue with `--repo` and `--org`.

## Narrowing and sorting

`alden queue --author bots`, `--label <name>` and `--search <text>` show only the PRs that match, and
`--sort age|waiting|updated|size` re-sorts them (oldest first, longest wait first, last updated first, smallest
first). These work on the ranked queue: ranking doesn't change, sorting happens inside Needs you and Fast-track
separately, and a line above the table says what's narrowed ("12 of 144 PRs: author bots"). `alden open 3` and
`alden review 3` take the numbers as shown. The web UI has the same search, filters and sort, and more (assignee, how
you were asked, CI, age, drafts); see [Search, filters and sort](web-ui.md#search-filters-and-sort).

Every PR's facts include its **assignees** (up to 10), read in the same request as the rest of its details: one more
small field per PR, no extra request. Queues cached before Alden read assignees are fetched again once.

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

**What you do moves PRs.** Alden learns which PRs you open ahead of their rank and which you mark useful or not
useful, and ranks PRs like them higher or lower, with the reason on the row ("ranked higher: you usually open PRs
touching app/api first", "ranked lower: you usually skip Dependabot PRs (4 marked not useful)"). See
[Learning and memory](memory.md).

**You can change the order.** Each signal is a weight you can turn up, down or off, and rules can put PRs first or
last. See [Your ranking](#your-ranking).

## Your ranking

Set it in Settings → Ranking in the web UI or the desktop app, where a preview shows your current queue's top 5 with
what's on screen before you save, or in `~/.alden/config.toml` under `[queue.rank]`. It's yours: it's read from your
user config only, so a repo's `.alden.toml` can't change how you rank.

### Weights

Each of the queue's signals adds points, and its weight multiplies them: `0` ignores the signal (no points, and its
reason leaves the row), `1` is the default, `2` doubles it. Weights go from 0 to 10.

| Weight | Signal | Points at 1 |
| --- | --- | --- |
| `urgentLabel` | A label like hotfix, urgent, critical, blocker, p0 or sev1. | 6 |
| `stacked` | Other open PRs are built on top of it. | 4 |
| `sameAuthor` | Its author (a person, not a bot) has several PRs waiting on you. | 2 |
| `ownsFiles` | CODEOWNERS gives you some of its files. | 1 |
| `waiting` | How long you've been asked. | 1.5 after 4 hours, 3 after a day, 4.5 after three days |
| `size` | Lines to read, lockfiles aside. | 1 past the fast-track size, 2 past 250 lines, 3 past 1,000 |
| `risk` | Sensitive paths, and a major dependency bump. | 2 each |
| `noTests` | Code changed without test changes. | 1 |
| `learned` | What Alden learned from the PRs you open first and mark useful. | up to 3, either way |

With every weight at 1, the order is exactly the one Alden has always used (a test pins it over the recorded PRs).
Failing CI isn't a weight: a PR whose CI fails always comes after the others, since its author has to act first.
Conflicts and drafts are shown on the row but don't score.

```toml
[queue.rank]
waiting = 2     # stale PRs matter twice as much to me
size = 0.5
learned = 0     # rank by the signals alone
```

### Rules

A rule picks out PRs and says what to do with them:

- `first`: above every PR no rule pins, in its lane (Needs you or Fast-track). PRs a first rule matches are ordered
  among themselves by the rest of the ranking.
- `last`: below them.
- `boost` and `lower`: add or take away points, 5 unless `by` says (an urgent label is worth 6).

`when` takes any of these, and every one given must hold:

| Condition | Matches |
| --- | --- |
| `path` | A changed file. A glob (`**/*.sql`), or a plain folder or file (`payments/`, `src/app.ts`) anywhere in the repo. Any case. |
| `label` | A label, in any case. |
| `author` | A login (`sam`, `dependabot`, `copilot`), or `people`, `bots` or `agents` (AI coding agents), the way [Bots and AI agents](#bots-and-ai-agents) tells them apart. |
| `repo` | `owner/name`, or an organisation for all of its repos. |
| `base` | The branch it merges into, or a glob: `main`, `release/*`. |
| `title` | Text the title contains, in any case. |

```toml
[[queue.rank.rules]]
when = { path = "payments/" }
then = "first"

[[queue.rank.rules]]
when = { author = "bots" }
then = "last"

[[queue.rank.rules]]
when = { label = "security", base = "main" }
then = "boost"
by = 8
name = "security fixes"   # how the row names it
```

Rules apply in the order you list them. A PR takes the first `first` or `last` rule it matches; every `boost` and
`lower` it matches adds up. Each applied rule leads the row's reasons: "↑ your rule: payments/ first", "↓ your rule:
bots last", "↑ your rule: security fixes +8".

Rules come after learning, and learning never overrides them: first and last order the lane before any score does,
and when learning would pull a PR against a boost or lower rule ("ranked lower: you usually skip bot PRs" on a PR
your rule boosts), Alden sets that learning aside for the PR.

Rules are plain data on purpose, described by `packages/schema/json/rank-settings.v1.json`, so a tool (or, later,
Alden Cloud turning "payments first, bots last" into rules) can write them the same way the settings page does.

### Why a PR ranks where it does

`alden queue --explain` adds each row's score by weight and rule, named as `[queue.rank]` names them:

```text
 1.  acme/shop#412     Charge in the customer's currency   @sam   2d   +120/-30   pass
     ↑ your rule: payments/ first · touches app/payments/ · no test changes
     score 6: waiting +3 · risk +2 · noTests +1 · ↑ your rule: payments/ first
```

A weight that isn't 1 shows as `waiting +6 (×2)`. `--json` carries the same breakdown on every row (`breakdown`, with
`pinned` for a first or last rule).

### What the desktop app briefs

The desktop app briefs the top PRs in Needs you while you're away, in this order, your weights and rules included: a
`first` rule's PRs are briefed before anything else. How many it keeps briefed is `background.prepare` (3 by default,
0 to 10), or "Keep the top PRs briefed in the background" in Settings → Ranking. See
[While you're away](desktop.md#while-youre-away).

### Bots and AI agents

Alden tells four kinds of author apart, and learns how you treat each, and each bot or agent:

- **You**: your own PRs.
- **People.**
- **Bots**: anything GitHub calls a bot or whose login ends in `[bot]` (Dependabot, Renovate, GitHub Actions, …),
  plus the `renovate-bot` and `snyk-bot` accounts.
- **AI agents**: the GitHub apps of Copilot (`Copilot`, `copilot-swe-agent`), Claude (`claude[bot]`), Devin
  (`devin-ai-integration[bot]`), Cursor (`cursor[bot]`), Codex (`chatgpt-codex-connector[bot]`), Jules
  (`google-labs-jules[bot]`), Amazon Q (`amazon-q-developer[bot]`) and Sweep (`sweep-ai[bot]`), and the
  `openhands-agent` account. A person's PR from an agent's branch (`claude/…`, `copilot/…`, `codex/…`, `cursor/…`,
  `devin/…`) counts as that agent's too. An agent's name only counts on a bot account, so a person whose login is
  `claude` stays a person.

The list lives in `packages/schema/src/authors.ts`, so the web UI's author filter uses it too. Alden reads only what the queue already fetches (the author's
login and type, and the branch name), so this costs no extra API calls; it doesn't read PR descriptions or commit
trailers ("Generated with Claude Code", `Co-authored-by`).

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
and other tools. Each row's `breakdown` is its score by weight and rule, as `--explain` shows it.
