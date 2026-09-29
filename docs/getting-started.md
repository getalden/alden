# Getting started

## Install

Alden needs Node 22 or later. Run it with `npx`, or install it globally:

```sh
npx alden@next --help
npm install -g alden@next
```

Pre-release builds are published under the `next` tag. The examples below assume a global install; with `npx`, put
`npx alden@next` in place of `alden`.

## Sign in to GitHub

```sh
alden auth login
```

If the GitHub CLI (`gh`) is signed in, Alden uses its token and stores nothing. Otherwise Alden shows a code to enter
at github.com, and stores the resulting token in your OS keychain. `alden auth status` shows which account and token
Alden is using. See [Commands](commands.md#alden-auth) for the other options.

Alden asks for the `repo` scope (to read private repos) and `read:org` (to see review requests sent to your teams).

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

1. **Needs your eyes**: at most 3 places, each with a file, a line and the reason.
2. **Checked**: every check Alden ran, what it found, and the evidence.
3. **Not checked**: what Alden couldn't check, so you know what's still on you.

See [Briefings and checks](checks.md).

## Add a model (optional)

Without a model, Alden runs only its deterministic checks. With one, the briefing also says what the change does,
whether it matches its title, and what else deserves a look.

```sh
export ANTHROPIC_API_KEY=...        # from console.anthropic.com
alden review 1
```

The default is Claude Sonnet, capped at $0.50 per review and $10 per day. Each briefing shows what it cost, and
`alden spend` shows the running total. See [Models, providers and budgets](models.md) for other models, AWS Bedrock,
Google Vertex, Azure Foundry and local models such as Ollama.

## Get callers outside the diff

For TypeScript, JavaScript and Python, Alden builds a code graph of the repo and lists who calls the code a change
touches. For local changes this just works. For a PR, run `alden review` from inside a clone of that PR's repo:

```sh
cd ~/code/their-repo
alden review 123
```

See [The code graph](code-graph.md).
