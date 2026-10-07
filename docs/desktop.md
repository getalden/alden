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
- The queue in the window searches, filters and sorts like the [web UI's](web-ui.md#views), and `[` folds it into a
  rail when you want the briefing at full width. The window remembers its filters, sort and fold across restarts.
- **Open Alden** (⌘⇧A) brings the window forward from anywhere. **Refresh** reloads the queue, which also happens
  every 5 minutes.
- When someone has waited three days on a PR that isn't waiting on its author, you get one notification for it.
- [Comment from Alden](web-ui.md#views) works the same in the window: **Comments** (or `s`) opens the drawer beside the
  briefing that collects your comments, with the verdict and **Send review** at its bottom; check the summary and send
  them to GitHub as one review. Drafts Claude Code added show there too, marked "from Claude". The window remembers
  whether the drawer is open until you quit; in a narrow window it's a full-width sheet. Nothing is sent until you
  press Send.
- [Guided review](web-ui.md#views) works the same in the window: `g` takes the places that need your eyes one at a
  time, with the code at each and the files to look at too. Links to files on GitHub open in your browser.
- The [Diff tab](web-ui.md#views) works in the window too: `d` switches between a briefing and its PR's diff, with
  Alden's places marked at their lines. A place's `file:line` opens the diff there; its **GitHub ↗** link, like every
  link to GitHub, opens in your browser. The window remembers which tab you were on until it closes.
- **Export** in a briefing works in the window too. **Save as Markdown** saves to your Downloads folder (the window
  can't download files itself) and says where, e.g. "Saved to ~/Downloads/acme-shop-412-briefing.md."; **Print / Save
  as PDF** opens the macOS print dialog, whose **PDF** menu saves it. See [Export](web-ui.md#views).
- Closing the window keeps Alden in the menu bar; clicking Alden in the Dock brings the window back. **Quit** stops it.

## While you're away

When your Mac has been idle for three minutes, Alden briefs the top PR waiting on you that doesn't have a briefing yet,
and tells you when it's ready ("Briefing ready: acme/shop#412 · 2 places need your eyes"). Open it and the briefing is
already there, marked "prepared while you were away"; **Brief again** makes a fresh one. It works through your top
three, one a minute while you're still away, skips drafts and PRs waiting on their author, and briefs a PR again only
after it changes: a new push, or new commits on its base branch (main moving can add callers of the code it changes).
A prepared briefing is shown only if its PR's head and base still match GitHub's when you open it; otherwise Alden
drops it and prepares a fresh one. While you're away it checks the ones it has every five minutes, one GitHub request
each. Ready PRs are marked in the menu and the queue.

"Top" is your queue's order, with [your weights and rules](queue.md#your-ranking): a rule that puts PRs touching
`payments/` first means those are briefed first. Set how many to keep briefed, 0 to 10, in Settings → Ranking ("Keep
the top PRs briefed in the background"; its preview marks the PRs that will be), or with
`alden config set background.prepare 5`. 0 briefs none.

These briefings use the checks and the code graph only, which costs nothing. To have them ask the model too, turn on
**Ask the model too** in Settings → While you're away; each then counts against your caps like any briefing. Turn the
whole thing off there, or with `alden config set background.enabled false`.

"Briefing ready" plays your system's notification sound. Turn it off in Settings → Notifications ("Play a sound when a
briefing is ready"), or with `alden config set notifications.sound false`. Focus modes and macOS's own notification
settings for Alden still apply. The three-day nudge stays silent.

## Sign-in

When Alden isn't signed in (or GitHub no longer accepts its sign-in), the window says so: **Sign in with GitHub** shows a
one-time code and opens GitHub's page, and the app picks up your approval by itself. **Use my GitHub CLI sign-in**
switches to the GitHub CLI's, when it's signed in on your Mac.

The app uses the same sign-in as the command line tool: the token `alden auth login` stored in your keychain, or the
GitHub CLI's if `gh` is signed in (the app looks for it where Homebrew installs it). See
[Getting started](getting-started.md#sign-in-to-github). If you signed in in a terminal, **I've signed in** looks again,
and if Alden still can't see it, says why: the keychain refused to answer, GitHub rejected the token, or there's no
sign-in anywhere.

An app opened from the Finder never sees your shell's `ANTHROPIC_API_KEY`. With no model, the briefing options offer
**Set up a model**: paste an Anthropic key (checked with one tiny request, then kept in the keychain), use a local model
through Ollama (downloaded for you if needed), or checks only. The app uses the key or model from the next briefing on,
without a restart. Its links (to the Anthropic Console, Ollama and Alden Cloud) open in your browser. `alden setup` and
`alden auth model` in a terminal, or Settings → Anthropic API key, work too. The app doesn't see `OLLAMA_HOST` either;
setting up a local model from a terminal where it's set writes the address into your config.

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
