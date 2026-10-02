# Alden desktop

Alden in a window and the menu bar. A [Tauri 2](https://tauri.app) shell around `alden ui`:

- It runs the bundled standalone `alden` binary as `alden ui --json` in the folder you choose ("Choose repo folder…"
  in the menu; your home folder until then), and shows the UI in its window.
- The menu bar shows how many PRs wait on you, the top three (click one to open its briefing), Open Alden (⌘⇧A,
  Ctrl+Shift+A elsewhere), Refresh and Quit. It reads the local API every 5 minutes.
- When someone has waited three days on a PR that isn't waiting on its author, you get one notification for it.
- While the Mac has been idle for 3 minutes, it calls the local `POST /api/prepare` once a minute to brief the top three
  PRs, and tells you when one is ready. See [docs/desktop.md](../../docs/desktop.md#while-youre-away).
- Sign-in is shared with the CLI: see [docs/desktop.md](../../docs/desktop.md#sign-in).
- Closing the window keeps Alden in the menu bar. Quitting stops the server; the server also stops by itself when this
  app's end of its stdin closes, so a crash can't leave it running.

The window only ever shows Alden's own server on 127.0.0.1 (and the bundled loading page), with the same session key
and checks as `alden ui` in a browser. It calls no Tauri commands, so the capability set is `core:default`.

## Install

Releases ship a universal (Apple silicon and Intel), signed and notarized `Alden-<version>-universal.dmg`, and a cask:
`brew install --cask getalden/tap/alden-desktop`. See [docs/desktop.md](../../docs/desktop.md).

## Build

Needs Rust (stable) and, on macOS, Xcode's command line tools.

```sh
pnpm desktop:build      # builds Alden, the binary, the sidecar and Alden.app
pnpm desktop:dev        # after `pnpm build:binary && pnpm desktop:sidecar`
```

The app lands in `src-tauri/target/release/bundle/macos/Alden.app`. For the universal app the release builds, run
`pnpm release:dry-run --desktop` (needs `rustup target add x86_64-apple-darwin`). Unsigned builds are for testing: macOS asks once
whether the bundled `alden` may read the sign-in Alden stored in your keychain (choose Always Allow).

## Icons

`icon-1024.png` is the app icon from the "Alden Brand System v2" design (a teal tile with the mark, inset to the macOS
icon grid); `pnpm --filter @alden/desktop app:icons` regenerates `src-tauri/icons` from it. `src-tauri/icons/tray.png`
is the mark alone in black, used as a template image so the menu bar tints it.
