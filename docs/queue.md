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

## Your turn

Above Needs you: the PRs you reviewed where something happened that you haven't seen. Each says what, in one line, and
when:

```text
Your turn (2)
  acme/shop#12  Charge in cents                                    3h ago
    Ana replied to 2 of your comments · 1 resolved
  acme/api#88   Retry the webhook                                  1d ago
    A push outdated your comment
    alden open <pr> or alden review <pr> opens one, and it leaves Your turn.
```

What counts: a reply to one of your comments (after your last word in that thread), a thread of yours resolved by
someone else, and a push that makes one of your comments outdated. Counts are of threads: two replies in one thread
are "replied to your comment". A reply you've already answered (on GitHub or from Alden) and a thread you resolved
yourself aren't news.

- **Opening the PR sees it.** In the web UI or the desktop app, opening it goes to the PR with the Comments drawer's
  Conversation open on the thread the news is in; the row stays while the PR is open and is gone once you move on. In a
  terminal, `alden open acme/shop#12` or `alden review acme/shop#12` (the rows aren't numbered, so `alden open 3` still
  means the third PR of the queue). Anything newer brings the PR back.
- **One list with the desktop app's notifications.** A notification you've seen doesn't take a PR off Your turn: only
  opening it does. Opening it before the desktop app tells you means it doesn't.
- **Re-reviews stay in Needs you.** A PR you were asked to review again is a review request, so it's ranked with the
  rest, labelled **Re-review**; any news on it shows on its row ("New · Ana replied to your comment", or
  `new: Ana replied to your comment` in the terminal) rather than under Your turn. The same goes for any PR in your
  queue: no PR is listed twice.
- **Your follow-up level applies**, per PR (`alden watch`, the bell) or globally (`notifications.followUps`): **Off**
  shows none of its news, **Re-review only** only the re-review (its Needs you row), and **When it's your turn** and
  **Every reply** all of it. The level decides what interrupts you; Your turn is there when you look, so it doesn't
  wait for a whole round to be answered.
- **Scope.** `--repo`, `--org`, `queue.repos`, `queue.orgs` and `queue.ignore` apply; the search, filters and sort
  don't (they narrow the queue). Which PRs are followed (the open ones you reviewed in the last 14 days) is in
  [Follow-ups](desktop.md#follow-ups-on-prs-you-reviewed).

**What it costs.** It's the desktop app's follow-up check, now also run when the web UI or `alden queue` fetches a
fresh queue: one read-only GraphQL request finds the PRs you reviewed and when each last changed, and only a PR whose
`updatedAt` moved since the last look has its review threads read (one request each, a few at a time). Every Alden on
your machine shares one check a minute: a queue fetched within a minute of the last check (here, in another terminal,
or by the desktop app) asks GitHub nothing for it. With every level Off it asks nothing at all. The queue waits up to
8 seconds for it, then shows what's stored, and the next queue has the rest. A cached queue (the UI's "As of 3 min ago")
shows what the last check found without asking.

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
with `CI failing: ping @author`. A **cancelled** run isn't failing: GitHub's summary counts one as a failure, so Alden
reads the runs themselves. A cancelled run of a check that ran again counts as that other run; when a cancelled run is
all that kept CI from passing, the row says **CI cancelled** (`cancelled` in `alden queue`) and the PR keeps its place,
neither sunk nor ready to approve, since CI didn't finish. Any other run that failed (or timed out) still makes CI
failing. Skipped and neutral runs pass, as GitHub counts them. When a commit has more than 100 runs, Alden can't read
them all, and goes by GitHub's summary.

**What you do moves PRs.** Alden learns which PRs you open ahead of their rank and which you mark useful or not
useful, and ranks PRs like them higher or lower, with the reason on the row ("ranked higher: you usually open PRs
touching app/api first", "ranked lower: you usually skip Dependabot PRs (4 marked not useful)"). See
[Learning and memory](memory.md).

**You can change the order.** Each signal is a weight you can turn up, down or off, and rules can put PRs first or
last. See [Your ranking](#your-ranking).

## Re-reviews

A PR is a **re-review** when you've submitted a review on it (approved, requested changes, commented, or one later
dismissed; not one you've started and not sent) and a review was requested from you, or one of your teams, after
that. Submitting a review clears GitHub's request for you, so a newer one means someone asked you again, usually
once they've acted on what you said.

- A re-review gets 2 points (the `rereview` weight) and leads its reasons with "Re-review: you were asked again", so it
  sits a little above a first look of similar risk. Its wait counts from when you were asked again.
- The row says so: **Re-review** and when you last reviewed in the web UI ("Re-review · reviewed 2 days ago"),
  `[Re-review]` before the title and "reviewed 2d ago" in the terminal.
- In the briefing, the Diff tab opens on the changes since the commit you reviewed. See
  [Since your review](web-ui.md#since-your-review).

Alden reads this from what the queue already fetches: your reviews on the PR (the last 20, each with the commit it was
on) and when you were last asked. It costs no extra requests. A PR you reviewed and weren't asked again carries the
same follow-up on `--json` (`followUp`) without the re-review mark.

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
| `rereview` | You reviewed it and were asked again: a [re-review](#re-reviews). | 2 |

With every weight at 1, the order is exactly the one Alden has always used, re-reviews aside (a test pins it over the
recorded PRs).
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
and other tools. Each row's `breakdown` is its score by weight and rule, as `--explain` shows it. A PR you reviewed
before has `followUp`: when you last reviewed (`lastReviewedAt`), the commit you reviewed when GitHub says
(`lastReviewedHead`), `rereviewRequestedAt` when it's a re-review, and `news` when something happened you haven't seen
(`text`, `at`, the `replies`, `resolved` and `outdated` thread counts, the `thread` to open on, and its follow-up
`events`). `yourTurn` is the [Your turn](#your-turn) group, newest first: each PR's `pr`, `repo`, `number`, `title`,
`url` and `news`.
