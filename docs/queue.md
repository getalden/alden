# The review queue

`alden queue` finds the open PRs that request a review from you, or from a team you're on, and ranks them. It only
orders the queue. It never approves, comments on or changes anything on GitHub.

## Which PRs are included

Open, non-archived PRs where your review is requested, directly or through a team. Each row shows which one. Drafts are
left out unless you pass `--include-drafts` or set `queue.includeDrafts`. Narrow the queue with `--repo` and `--org`.

## Needs you

Ranked by three factors, in this order of weight. **Blocking beats waiting beats risk.**

1. **Blocking.** The PR has an urgent or hotfix label, another PR is stacked on it, or its author has several PRs
   waiting on you. Bots (such as Dependabot) don't get the "author waiting" boost.
2. **Waiting.** How long ago your review was requested.
3. **Risk.**
   - Size. Lockfiles don't count.
   - Sensitive paths, such as migrations, auth, payments, infrastructure, CI config and lockfiles. See
     [`queue.sensitivePaths`](configuration.md#queue).
   - Code changed without test changes.
   - Files CODEOWNERS assigns to you.

Every row gives its reasons, for example `waiting 3d · touches migrations/ · no tests`.

**Failing CI sinks a PR.** When a PR's CI is failing, the author has to act before you do, so it drops to the bottom
with `CI failing: ping @author`.

**What you do moves PRs.** Alden learns which PRs you open ahead of their rank and which you mark useful or not
useful, and ranks PRs like them higher or lower, with the reason on the row ("ranked higher: you usually open PRs
touching app/api first", "ranked lower: you usually skip Dependabot PRs (4 marked not useful)"). See
[Learning and memory](memory.md).

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

The list lives in `packages/core/src/learn/authors.ts`. Alden reads only what the queue already fetches (the author's
login and type, and the branch name), so this costs no extra API calls; it doesn't read PR descriptions or commit
trailers ("Generated with Claude Code", `Co-authored-by`).

## Fast-track

A PR is fast-tracked when all of these hold:

- It's small: under 50 changed lines by default (`queue.fastTrackMaxLines`), not counting lockfiles.
- CI passed, it has no merge conflicts, and it isn't a draft.
- It only touches docs, only touches tests, or only bumps a dependency's patch version.

In a repo with no CI, only docs-only PRs qualify, because nothing has built or tested the others.

Fast-track means "you can probably clear this quickly". It's still your review.

## Caching and JSON

Results are cached for 60 seconds in `~/.alden/cache`. `--refresh` skips the cache. `--json` prints the ranked queue
in the format described by `packages/schema/json/ranked-queue.v1.json`, for scripts and other tools.
