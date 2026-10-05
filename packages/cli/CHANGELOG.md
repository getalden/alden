# alden

## 0.3.2

### Patch Changes

- e1f64df: `alden review <n>` says which PR the number picked from your last queue, and, inside a clone of another repo, how to review that repo's PR with the same number. In the web UI and desktop app, a PR you dismissed shows normally again when it changes and comes back, instead of staying struck through until the window reopens.

## 0.3.1

### Patch Changes

- 4d0b0f8: `alden auth model` and the Settings key field accept every kind of Anthropic API key, not only those starting `sk-ant-api`. Claude.ai sign-in tokens and Admin keys are still refused.
- 4d0b0f8: The web UI and desktop app strip escape codes from PR titles, branches and paths too, as the terminal does since 0.3.0.

## 0.3.0

### Minor Changes

- 84ee6fa: Sharper checks: a `critical` severity for likely secrets and migrations that can lose data; a new "Text aimed at AI
  reviewers" check; moved and deleted files flag the files still importing their old path, and show where they moved
  from; comment-only changes and pure moves no longer count as untested code; package.json `resolutions` and
  `overrides` count as dependency changes; callers in code take places before callers in tests; and Python callers
  through `from .services import product_sync` are found.
- 0e63f1c: PR briefings find callers in your clone of the PR's repo wherever Alden runs: it remembers each clone it runs in, and
  searches the folders in the new `clones.folders` setting (e.g. `~/src`). The web UI says which clone callers came from.
- e23c95d: `alden completion zsh|bash|fish` prints a tab-completion script for every command and flag (`alden completion --help`
  says how to install it). In a terminal, `alden queue`, `alden review` and `alden doctor` end with a dim "Next:" line
  suggesting the obvious next command; never with `--json` or in a pipe. `alden queue`'s "Open one with `alden open
  <#>`" line moves into it, so piped output no longer ends with a hint.
- 8f43f9f: Learning you can see, about the PRs that matter now. The queue learns code areas ("you open PRs touching app/api
  first") and who wrote a PR: you, people, bots or AI agents (Copilot, Claude, Devin, Cursor, Codex and more), and which
  one ("you usually skip Dependabot PRs"). Every useful or not useful says how close it brought a lesson ("2 of 3: one
  more not useful on API change flags and Alden will quieten them"), in `alden ui`, `alden_feedback` and `alden feedback`.
  Quietened checks say so in the checks list, the model is told to stop raising them, and model findings tagged with a
  topic teach the same lessons as the checks. Changed signatures and callers outside the diff now count as one API change
  lesson, and learning text says useful and not useful throughout.
- 85f4677: `alden auth model` stores your Anthropic API key in the keychain (asked for without showing it, or read from standard
  input), so the desktop app, `alden ui` and `alden mcp` find it too; `--remove` takes it out, and Settings has a
  write-only field for it. `alden auth status` and `alden doctor` say where the key comes from, never the key. The order
  is ANTHROPIC_API_KEY (and the other Anthropic variables), then the stored key, then an `ant auth login` profile.
- fb8c6aa: The queue loads about three times faster: the search only fetches ids, and PR details, CODEOWNERS and stacked counts
  load side by side (`ALDEN_DEBUG=queue` shows where the time goes). Major dependency bumps now rank higher, with a reason
  like "major bump: nesbot/carbon 3 → 4". The web UI and desktop app show the last queue at once while a fresh one
  loads, fetch the whole queue so the repo filter lists every repo, and each PR shows one waiting time: since you were
  asked.

### Patch Changes

- 9f2ae1c: Evidence under Checked in `alden review` wraps instead of being cut at the terminal's edge, and a changed signature
  shows its old and new forms on lines of their own, with the part that changed in colour.
- fe94827: Desktop and web UI fixes: clicking Alden in the Dock brings the window back; choosing a repo folder says where callers
  now come from and shows that repo's PRs (with Show all repos); "I've signed in" says what failed (the keychain refused,
  GitHub rejected the token, or no sign-in anywhere) instead of doing nothing; the Settings toggles fill their box; and
  `release:dry-run --desktop` unregisters and deletes the unsigned Alden.app it built, which could open instead of the
  installed app.
- 570978a: With `--include-drafts`, `alden queue` tags each draft `[Draft]` before its title and dims its row, so drafts stand out
  from PRs ready for review.
- cb9ad7e: `alden queue` shows what it's doing while it works ("Checking acme/shop (2 of 5)…", "Seeing what needs your eyes…"),
  on standard error and only in a terminal, instead of looking hung.
- 76b5fec: Escape sequences in PR titles, paths, branch names and bodies are removed whole, so a title like `\e[31mFix\e[0m`
  shows as "Fix", not "[31mFix[0m". Links, window titles and clipboard writes go the same way; accents and emoji stay.

## 0.2.3

### Patch Changes

- Choose how many places "Needs your eyes" holds: `review.eyes`, 1 to 10 (3 by default), in Settings or with
  `alden config set review.eyes 5`.

- When the model's thinking uses up all its room before it answers (one PR in six in the latest eval, whatever the
  PR's size), Alden now asks once more with low effort and less room, within what's left of your per-review cap (sending only the files that fit, for
  a big PR), instead of discarding the review. The briefing says when it did. Failed model calls now say what went wrong.

- Set what your queue covers on each machine: `queue.orgs`, `queue.repos` and `queue.ignore` in your user config (or
  Settings → Your queue on this machine). Only your company's organisation on a work laptop, only your own repos on a
  personal one; the terminal, the web UI, the desktop app and `alden mcp` all follow it, `--repo` and `--org` override
  it for one run, and a repo's `.alden.toml` can't change it. Doctor shows the scope, and only warns about
  organisations inside it. `alden config set` takes comma-separated lists.

- `alden doctor` and the queue now find organisations that hide themselves from Alden's own sign-in. GitHub leaves
  such an organisation out of the sign-in's list of your organisations altogether, so Alden also checks your public
  memberships and the organisations the GitHub CLI's sign-in can see, and probes each one.

## 0.2.2

### Patch Changes

- The desktop app sets itself up without a terminal. Installing it installs the `alden` command too: the Homebrew cask
  links it into Homebrew's bin, and the app links it into /usr/local/bin on its first launch (macOS asks for your
  password only if that folder needs it). Signing in to GitHub works from the window: Sign in with GitHub shows a
  one-time code and opens GitHub's page, or Use my GitHub CLI sign-in switches to the GitHub CLI's. The same sign-in
  card shows in `alden ui`.

## 0.2.1

### Patch Changes

- Say when an organisation hides its PRs from your sign-in. Organisations that use single sign-on, or allow only
  approved apps, leave their PRs out of the queue without an error; `alden doctor` now names each one with the fix for
  your kind of sign-in, and the queue, the web UI and the desktop menu warn about them. The desktop app can install the
  `alden` command (Install command line tool… in the menu), and `alden auth login --device` opens GitHub when you press
  Enter. Windows binaries build again.

## 0.2.0

### Minor Changes

- The second beta: Alden learns from you, has a new look and a desktop app, and works inside Claude Code and other AI
  coding tools.
  
  - **Learns from you.** Mark places useful or not useful, react to queue rows, and dismiss what you don't need: after
    three one-sided reactions Alden gives that kind of flag more or less weight, and ranks PRs like the ones you open
    first higher. Notes you add (`alden memory add`) go to the model. Everything it learns is listed in `alden memory` and
    the Memory view, with where it came from, and you can edit, forget or pause any of it.
  - **Local database.** Alden's data now lives in SQLite at `~/.alden/alden.db`. Your old JSON files are imported once
    and kept in `~/.alden/legacy/`. Needs Node 22.13 or later.
  - **New look.** The web UI is redesigned, with light and dark themes, a two-pane workspace and keyboard reactions
    (`+`, `−`, `x`).
  - **Desktop app.** Alden in a window and the menu bar on macOS, with the queue count, a reminder for PRs that have
    waited three days and ⌘⇧A to open it. While your Mac is idle it briefs the top PRs waiting on you (checks and
    callers only, unless you allow the model in Settings) and tells you when one is ready.
  - **In your AI coding tool.** `alden mcp` gives Claude Code, Cursor, Claude Desktop and other MCP clients Alden's
    queue, briefings, feedback and memory as tools. The Claude Code plugin adds `/alden:review`, `/alden:queue` and
    `/alden:remember`: `claude plugin marketplace add getalden/claude-plugin`, then
    `claude plugin install alden@getalden`.
  - **Opt-in usage stats.** Alden asks once whether to send anonymous usage counts (never code, names or repos) to help
    us improve it. Off unless you say yes; `alden telemetry show` lists exactly what would be sent.
