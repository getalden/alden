# alden

## 0.2.0

### Minor Changes

- The second beta: Alden learns from you, has a new look and a desktop app.
  
  - **Learns from you.** Mark places useful or not useful, react to queue rows, and dismiss what you don't need: after
    three one-sided reactions Alden gives that kind of flag more or less weight, and ranks PRs like the ones you open
    first higher. Notes you add (`alden memory add`) go to the model. Everything it learns is listed in `alden memory` and
    the Memory view, with where it came from, and you can edit, forget or pause any of it.
  - **Local database.** Alden's data now lives in SQLite at `~/.alden/alden.db`. Your old JSON files are imported once
    and kept in `~/.alden/legacy/`. Needs Node 22.13 or later.
  - **New look.** The web UI is redesigned, with light and dark themes, a two-pane workspace and keyboard reactions
    (`+`, `−`, `x`).
  - **Desktop app.** Alden in a window and the menu bar on macOS, with the queue count, a reminder for PRs that have
    waited three days and ⌘⇧A to open it.
  - **Opt-in usage stats.** Alden asks once whether to send anonymous usage counts (never code, names or repos) to help
    us improve it. Off unless you say yes; `alden telemetry show` lists exactly what would be sent.
