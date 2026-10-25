# Evals

Prompt and model changes are measured against recorded public PRs before they ship.

## Running

```sh
pnpm eval                                  # prints what a run would cost; calls nothing
pnpm eval --yes                            # runs every recorded PR through the model review
pnpm eval --yes --model opus --effort medium
pnpm eval --yes --only django              # one recorded set (django.json); --only reg-cli,hugo takes several
pnpm eval --yes --pr cli/cli#13009         # single PRs, comma-separated
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

## Callers: does the graph find what a signature change breaks?

```sh
pnpm eval:callers ~/src/mastodon --languages ruby       # last 40 cases since 2024
pnpm eval:callers ~/src/okhttp --since 2022-01-01 --limit 30 --verbose --json out.json
pnpm eval:callers ~/src/okhttp --commit 6b134f769a      # one commit
```

This one needs no labels, no GitHub access and no model, only a clone. It walks the repo's history for commits that
changed a function's or method's signature and, in the same commit, edited other files calling it. Those edits are the
answer key: the callers the author had to update. Each case replays the commit without them (the parent commit plus
only the file defining the symbol, at its new version) and asks the graph for callers outside the diff. It reports how
many of those caller files the graph listed, by language, and how many other files it listed besides.

The key is a word match on the edited lines, so it's a little noisy: a same-named method of another class edited in the
same commit counts as a caller too. Only call sites count (`x.name`, `name(`, `name {`, Ruby's `name arg`, `:name`), not
properties, parameters, named arguments, imports, comments or strings; constructors only where they're called
(`Foo.new`, `Foo(`, `new Foo(`); names every service has (`call`, `perform`) only in files naming the class; and not a
file importing a same-named function from elsewhere (`kotlin.concurrent.withLock`). Read the misses (`--verbose`) before
blaming the graph.

On 25 Oct 2026, 30 cases per repo since 2022. Each column adds a round of fixes this eval turned up:

| Repo | Language | First version | Namespaces, imports | Declared types | More receivers | Reviewed key |
| --- | --- | --- | --- | --- | --- | --- |
| we-promise/sure | Ruby (Rails) | 35/45 | 41/45 | 41/45 | 41/45 | 41/43 |
| mastodon/mastodon | Ruby (Rails) | 16/59 | 45/59 | 55/59 | 56/59 | 56/57 |
| Alamofire/Alamofire | Swift | 47/52 | 47/52 | 47/52 | 51/52 | 51/51 |
| kickstarter/ios-oss | Swift | 40/51 | 40/51 | 40/51 | 44/51 | 44/46 |
| android/nowinandroid | Kotlin | 49/67 | 56/67 | 52/67 | 53/67 | 53/53 |
| square/okhttp | Kotlin, Java | 24/44 | 28/44 | 25/44 | 29/44 | 29/29 |
| thunderbird/thunderbird-android | Kotlin, Java | 36/46 | 40/46 | 36/46 | 36/46 | 35/35 |
| google/gson | Java | 14/17 | 16/17 | 16/17 | 16/17 | 16/16 |
| square/retrofit | Java | 9/11 | 9/11 | 9/11 | 10/11 | 10/10 |
| **All** | | **270/392 (69%)** | **322/392 (82%)** | **321/392 (82%)** | **336/392 (86%)** | **335/340 (99%)** |
| Other files listed, all cases | | 1707 | 1557 | 1455 | 1467 | |

- **Namespaces, imports:** Ruby classes told apart by namespace (`PlaidAccount::Processor` vs
  `RedbarkAccount::Processor`), calls on `Namespace::Service.new`, a concern's private helpers, RSpec's
  `described_class` and `subject`; Java and Kotlin nested classes, members imported by name (Kotlin extensions, Java
  static imports) and Kotlin extension functions on outside types.
- **Declared types:** a receiver declared with a type (`val transport: Transport`, `Client client`, `let request =
  DataRequest(…)`, Ruby's `client = Api::Client.new` and RSpec's `let(:service) { instance_double(Service) }`) is that
  type, whatever it's named; RSpec's `expect(service).to have_received(:call)` counts as a call. Kotlin's apparent
  drop is the graph rightly leaving out calls on variables typed as another class with a same-named method, which is
  also why it lists fewer other files.
- **More receivers:** calls through a variable typed as a parent or interface, however common the method's name;
  nested parents (`class DnsOverHttpsCall : Dns.Call`); Kotlin's `navController::navigateToTopic` and
  `RealEventSource(…).apply { connect(client) }`; Swift's `$state` (a property wrapper), string literals and leading-dot
  calls (`.chunked(size)`); Pundit's `record` and a serializer's `object`; and what a function in the same file returns
  (`loadServiceMethod(method).invoke(args)`).
- **Reviewed key:** every remaining miss was read against its commit. 50 aren't calls of the changed symbol: a
  same-named method of another class edited in the same commit, a property read, a declaration. They're listed with the
  reason in `eval/callers-key-review.json`, which the eval reads to report `reviewedRecall`. Only misses were reviewed,
  so this is an upper bound. The 5 real misses left: `provider.fetch_property_valuation` (a provider looked up at run
  time), `cell.configureWith(value:)` on a dequeued cell, and a view helper `vite_stylesheet_tag` that a gem extension
  prepends.

The summary also counts each caller file once per commit and name (`distinctCallers`), since overloads and same-named
methods changed in one commit are a case each, and the same without test files (`distinctNonTestCallers`). For the
"More receivers" column those are 242/267 (91%) and 186/201 (93%), before any review.

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
  request your own review, so the PRs come from a GitHub App: set `ALDEN_E2E_APP_ID` and `ALDEN_E2E_APP_KEY` (the path
  to its private key), with the app installed on the repo and given Contents, Pull requests, Issues and Workflows read
  and write. (A second account's classic token in `ALDEN_E2E_AUTHOR_TOKEN` works too, but GitHub flags a new account
  that opens dozens of PRs as spam and hides everything it made; apps are made for this.) The PRs go to a
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
