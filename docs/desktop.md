# The desktop app

On macOS, Alden can live in a window and the menu bar. The app is the same Alden: it runs its own copy of `alden ui`
and shows it in a window, so everything in [The web UI](web-ui.md) works the same way.

## Install

```sh
brew install --cask getalden/tap/alden-desktop
```

Or download `Alden-<version>-universal.dmg` from the [releases page](https://github.com/getalden/homebrew-tap/releases)
and drag Alden to Applications. It runs on Apple silicon and Intel Macs with macOS 12 or later, and it's signed and
notarized, so it opens without a warning.

The app carries its own copy of `alden`, which it runs in the background. To use it in a terminal as well (and for
`alden mcp` and the Claude Code plugin), choose **Install command line tool…** in the menu: it links the app's `alden`
into `/usr/local/bin` after macOS asks for your password, and updates with the app. If you've installed `alden` with
Homebrew or npm already, there's nothing to do: the app and the command share `~/.alden`, so the same sign-in,
settings, memory and spend.

## Using it

- **Choose repo folder…** in the menu picks the clone Alden reviews from (your home folder until you choose one). Alden
  remembers it.
- The menu bar shows how many PRs wait on you and the top three; click one to open its briefing. If an organisation hides
  its PRs from your sign-in, the menu says some are hidden, and the window says which and why.
- **Open Alden** (⌘⇧A) brings the window forward from anywhere. **Refresh** reloads the queue, which also happens
  every 5 minutes.
- When someone has waited three days on a PR that isn't waiting on its author, you get one notification for it.
- Closing the window keeps Alden in the menu bar. **Quit** stops it.

## While you're away

When your Mac has been idle for three minutes, Alden briefs the top PR waiting on you that doesn't have a briefing yet,
and tells you when it's ready ("Briefing ready: acme/shop#412 · 2 places need your eyes"). Open it and the briefing is
already there, marked "prepared while you were away"; **Brief again** makes a fresh one. It works through your top
three, one a minute while you're still away, skips drafts and PRs waiting on their author, and briefs a PR again only
after it changes. Ready PRs are marked in the menu and the queue.

These briefings use the checks and the code graph only, which costs nothing. To have them ask the model too, turn on
**Ask the model too** in Settings → While you're away; each then counts against your caps like any briefing. Turn the
whole thing off there, or with `alden config set background.enabled false`.

## Sign-in

The app uses the same sign-in as the command line tool: the token `alden auth login` stored in your keychain, or the
GitHub CLI's if `gh` is signed in (the app looks for it where Homebrew installs it). If neither is there, the app says
so; sign in once from the terminal with `alden auth login`. See
[Getting started](getting-started.md#sign-in-to-github).

## Uninstall

```sh
brew uninstall --cask alden-desktop
```

Or drag Alden from Applications to the Bin. `~/.alden` stays, since the command line tool uses it too; see
[Privacy and data](privacy.md) to remove it.
