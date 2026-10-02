# Security model

What Alden protects, against whom, and how. For reporting a problem, see [SECURITY.md](../SECURITY.md).

## What's worth protecting

- **Your GitHub token**, which can read your private repos.
- **Your model budget**: anyone who can run reviews as you spends it.
- **Your code**, which Alden reads to build briefings, and parts of which it sends to your model provider.

## Who might try

- **PR authors.** Alden reviews code from people you don't know, so everything in a PR is untrusted: titles,
  descriptions, branch names, file names and the code itself.
- **Websites you visit** while `alden ui` is running.
- **Other users and processes** on the same machine.

## How Alden handles it

**Tokens.** Your GitHub token lives in the OS keychain, or, where there's no keychain, a file only your user can
read. Alden never logs it, never sends it anywhere but GitHub, and never puts it in a prompt. Model keys come from
the provider's own configuration and stay with its SDK.

**`alden ui`.** The server listens on 127.0.0.1 only. Every API call must carry a random session key, which reaches
the browser in the link's `#fragment` (never sent to a server or in a Referer) and is compared in constant time. The
server also rejects any Host or Origin that isn't its own, which stops other websites, including through DNS
rebinding. It sends no CORS headers, so other pages can't read its responses. Pages get a strict Content Security
Policy (only Alden's own scripts, styles and images, plus GitHub avatars), can't be framed, and send no referrer.

**PR content.**

- Alden never runs code from a PR. It checks PRs out into its own worktrees only to parse them; git doesn't run hooks
  from a repo's content, and files over 512 KB aren't parsed.
- Everything a PR author wrote is shown as text: escaped in the web UI, and with terminal control characters removed
  in the CLI, so a PR title can't rewrite your terminal or write to its clipboard.
- The model is told that the title, description, diff and code are material to review, not instructions, and to
  report any attempt to instruct it. It has no tools: it can only return a briefing, and any finding that points
  outside the diff is dropped.

**Secrets in diffs.** Before a prompt is sent, anything that looks like a credential is replaced with a placeholder
that keeps only its kind and length (see [Privacy and data](privacy.md)). Detection is heuristic, so use `--no-llm`
for changes you know contain secrets, and rotate any secret that was committed.

**Your data.** Nothing goes to Alden's developers except anonymous usage stats, and only if you opt in ([Usage stats](telemetry.md)). Feedback, memory, spend and settings stay in `~/.alden`;
`alden feedback --export` leaves out repo names, paths and notes unless you pass `--full`.

**Supply chain.** Dependencies are audited before each release (`pnpm audit`), lockfiles are committed, and
releases are built in CI from a tag, with macOS binaries signed and notarized.

## Known limits

- **Prompt injection** can still make the model's part of a briefing wrong or quiet: an author can try to talk the
  model out of a finding. The deterministic checks don't read instructions, and every claim shows its evidence, so
  read the model's view as one opinion.
- **Secret redaction** catches known key formats, private keys, passwords in URLs and random-looking values assigned to
  secret-like names. A secret in an unusual shape can get through.
- The standalone binary isn't sandboxed beyond what your OS applies to any program you run.
