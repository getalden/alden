# alden

## 0.2.3

### Patch Changes

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
