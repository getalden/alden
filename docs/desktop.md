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

The app and the `alden` command line tool install side by side and share `~/.alden`: the same sign-in, settings,
memory and spend.

## Using it

- **Choose repo folder…** in the menu picks the clone Alden reviews from (your home folder until you choose one). Alden
  remembers it.
- The menu bar shows how many PRs wait on you and the top three; click one to open its briefing.
- **Open Alden** (⌘⇧A) brings the window forward from anywhere. **Refresh** reloads the queue, which also happens
  every 5 minutes.
- When someone has waited three days on a PR that isn't waiting on its author, you get one notification for it.
- Closing the window keeps Alden in the menu bar. **Quit** stops it.

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
