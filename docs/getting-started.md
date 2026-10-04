# Getting started

## Install

Alden is in open beta: anyone can install it, and it's free during the beta. Pick one of these.

**The desktop app, on macOS.** Alden in a window and the menu bar, which briefs your top PRs while you're away. It's
signed and notarized, runs on Apple silicon and Intel (macOS 12 or later), and installs the `alden` command too, so it
can be your only install. See [The desktop app](desktop.md).

```sh
brew install --cask getalden/tap/alden-desktop
```

Or download `Alden-<version>-universal.dmg` from the [releases page](https://github.com/getalden/homebrew-tap/releases).

**Homebrew, on macOS or Linux.** The `alden` command as a standalone binary, which needs nothing else.

```sh
brew install getalden/tap/alden
```

**npm, anywhere with Node 22.13 or later.** During the beta, releases are published under the `next` tag.

```sh
npm install -g alden@next
npx alden@next --help                # or run it without installing
```

**A standalone binary.** For macOS (Apple silicon and Intel), Linux (x64 and arm64) and Windows (x64), from the
[releases page](https://github.com/getalden/homebrew-tap/releases): `alden-<version>-<platform>.tar.gz`, or `.zip` for
Windows, with a `SHA256SUMS` to check it against. Unpack it and put `alden` (`alden.exe`) on your PATH.

The examples below assume `alden` is installed; with `npx`, put `npx alden@next` in place of `alden`.

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

## Or in your browser

```sh
alden ui
```

The queue, briefings, your feedback and what Alden learned, in a local web page. See [The web UI](web-ui.md).

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

## In Claude Code

With Alden installed and signed in, add the plugin in Claude Code:

```text
/plugin marketplace add getalden/claude-plugin
/plugin install alden@getalden
```

(Or from a terminal: `claude plugin marketplace add getalden/claude-plugin`, then
`claude plugin install alden@getalden`.) Then `/alden:review` and `/alden:queue`. See
[Claude Code plugin](claude-code.md).

## Get help

Ask in the [Alden Community on Discord](https://discord.gg/ZtXFX7sxTu), where you can also tell us what works and what
doesn't. For errors, start with `alden doctor` and [Troubleshooting](troubleshooting.md).
