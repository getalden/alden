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

The app comes with the `alden` command, so the terminal, `alden mcp` and the Claude Code plugin work without a second
install:

- **With Homebrew,** the cask links the app's `alden` into Homebrew's `bin`, which is already on your PATH. If you'd
  installed the `alden` formula first, its command stays.
- **From the .dmg,** the app installs the command on its first launch: it links it into `/usr/local/bin`, and macOS asks
  for your password if that folder needs it. If you cancel, Settings → Command line tool (or **Install command line
  tool…** in the menu) does it later.

Either way the command points into Alden.app, so it updates with the app, and the app and the command share `~/.alden`:
the same sign-in, settings, memory and spend.

## Using it

- **Choose repo folder…** in the menu picks the folder Alden runs in (your home folder until you choose one), which is
  where your uncommitted changes come from. Alden remembers it. Right after you choose, the window says where callers
  now come from and shows that repo's PRs only; **Show all repos** goes back to everything.
- PR briefings find callers in any clone Alden knows, not only the chosen folder: each clone you've run Alden in, and
  the clones under `clones.folders` (see [Configuration](configuration.md#clones)). The briefing says which clone.
- The menu bar shows how many PRs wait on you and the top three; click one to open its briefing. If an organisation hides
  its PRs from your sign-in, the menu says some are hidden, and the window says which and why.
- **Open Alden** (⌘⇧A) brings the window forward from anywhere. **Refresh** reloads the queue, which also happens
  every 5 minutes.
- When someone has waited three days on a PR that isn't waiting on its author, you get one notification for it.
- Closing the window keeps Alden in the menu bar; clicking Alden in the Dock brings the window back. **Quit** stops it.

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

When Alden isn't signed in (or GitHub no longer accepts its sign-in), the window says so: **Sign in with GitHub** shows a
one-time code and opens GitHub's page, and the app picks up your approval by itself. **Use my GitHub CLI sign-in**
switches to the GitHub CLI's, when it's signed in on your Mac.

The app uses the same sign-in as the command line tool: the token `alden auth login` stored in your keychain, or the
GitHub CLI's if `gh` is signed in (the app looks for it where Homebrew installs it). See
[Getting started](getting-started.md#sign-in-to-github). If you signed in in a terminal, **I've signed in** looks again,
and if Alden still can't see it, says why: the keychain refused to answer, GitHub rejected the token, or there's no
sign-in anywhere.

An app opened from the Finder never sees your shell's `ANTHROPIC_API_KEY`. Store the key with `alden auth model`, or in
Settings → Anthropic API key, and the app uses it from the keychain.

## Development builds

`pnpm desktop:build` and `pnpm release:dry-run --desktop` build an unsigned Alden.app. macOS registers it like any
app, so it can open instead of the installed Alden, and unsigned it can't read the keychain: it asks you to sign in
however you've signed in. The dry run unregisters and deletes its app once it has checked it (keeping the DMG);
`desktop:build` keeps its app and warns. `pnpm desktop:forget-build` unregisters and deletes every Alden.app this
checkout built.

## Uninstall

```sh
brew uninstall --cask alden-desktop
```

Or drag Alden from Applications to the Bin. `~/.alden` stays, since the command line tool uses it too; see
[Privacy and data](privacy.md) to remove it.
