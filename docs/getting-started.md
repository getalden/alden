# Getting started

## Install

With Homebrew, on macOS or Linux (the standalone binary, which needs nothing else):

```sh
brew install getalden/tap/alden
```

Or with npm, which needs Node 22.13 or later:

```sh
npm install -g alden@next
npx alden@next --help                # or run it without installing
```

During the private beta, npm releases are published under the `next` tag. The examples below assume `alden` is
installed; with `npx`, put `npx alden@next` in place of `alden`. There are also standalone binaries for macOS, Linux
and Windows on the [releases page](https://github.com/getalden/homebrew-tap/releases).

On a Mac you can also have Alden in a window and the menu bar (the app installs the `alden` command too, so it can
be your only install), which briefs your top PRs while you're away: see
[The desktop app](desktop.md).

## Sign in to GitHub

```sh
alden auth login
```

If the GitHub CLI (`gh`) is signed in, Alden uses its token and stores nothing. Otherwise Alden shows a code to enter
at github.com, and stores the resulting token in your OS keychain. `alden auth status` shows which account and token
Alden is using. See [Commands](commands.md#alden-auth) for the other options.

Alden asks for the `repo` scope (to read private repos) and `read:org` (to see review requests sent to your teams).

**At a company?** Alden needs no install on your organisation: it reads what your own sign-in can read. But many
organisations use single sign-on or only allow approved apps, and then hide their PRs from a sign-in until it's
authorized. Run `alden doctor` after signing in: it names any organisation whose PRs Alden can't see, and how to fix it.
If your company already uses the GitHub CLI, its sign-in is usually the quickest route. See
[Troubleshooting](troubleshooting.md#github).

## See what's waiting on you

```sh
alden queue
```

The PRs waiting on your review, in two groups: **Needs you**, ranked, and **Fast-track**, for small low-risk PRs you
can clear quickly. Every row says why it ranks where it does. Open one with `alden open <#>`. See
[The review queue](queue.md).

## Get a briefing

```sh
alden review 1                       # #1 from your last queue
alden review owner/repo#123          # or any PR
alden review https://github.com/owner/repo/pull/123
alden review                         # or your own uncommitted changes
```

A briefing has three parts:

1. **Needs your eyes**: a few places (3 unless you change `review.eyes`), each with a file, a line and the reason.
2. **Checked**: every check Alden ran, what it found, and the evidence.
3. **Not checked**: what Alden couldn't check, so you know what's still on you.

See [Briefings and checks](checks.md).

## Add a model (optional)

Without a model, Alden runs only its deterministic checks. With one, the briefing also says what the change does,
whether it matches its title, and what else deserves a look.

```sh
alden auth model                    # paste your key from console.anthropic.com; it's kept in the keychain
alden review 1
```

`ANTHROPIC_API_KEY` works too, and comes first where it's set.

The default is Claude Sonnet, capped at $0.50 per review and $10 per day. Each briefing shows what it cost, and
`alden spend` shows the running total. See [Models, providers and budgets](models.md) for other models, AWS Bedrock,
Google Vertex, Azure Foundry and local models such as Ollama.

## Get callers outside the diff

For TypeScript, JavaScript, Python, Go and PHP, Alden builds a code graph of the repo and lists who calls the code a change
touches. For local changes this just works. For a PR, run `alden review` from inside a clone of that PR's repo:

```sh
cd ~/code/their-repo
alden review 123
```

See [The code graph](code-graph.md).
