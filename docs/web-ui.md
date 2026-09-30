# The web UI

```sh
alden ui
```

Opens your review queue in the browser. Everything the CLI shows, the UI shows, from the same briefing format: the
queue, each PR's briefing with every check's evidence and the callers outside the diff, and reviews run with the
model and effort you pick.

Run it from a clone of the repo you review, as with `alden review`: that's where Alden finds callers for PRs, and
what "My changes" reviews.

| Flag | What it does |
| --- | --- |
| `--port <n>` | Serve on this port instead of a free one. |
| `--no-open` | Print the link instead of opening a browser. |

Stop it with Ctrl+C.

## Views

- **Queue.** "Needs you" and "Fast-track", with each PR's wait, size, CI and the reasons it ranks where it does.
  Filter by repo, refresh, and pick a PR to see its briefing beside the list.
- **A PR.** "Brief me" runs the review and shows each stage as it goes (fetching, finding callers, checks, the
  model). The briefing follows the CLI's order. Every place links into the PR's "Files changed" view at that line.
  A review keeps running if you look at another PR, and its briefing is there when you come back.
- **My changes.** Your uncommitted changes in the repo `alden ui` started in, before you open a PR.
- **Settings.** The default model, effort and caps, saved to your user config as `alden config set` does, and what
  you've spent today.

Each review has its own options: ask the model or not, which model, which effort, and whether to find callers. The
line beside them shows the per-review cap and what's left of today's budget. These choices last until you close the
tab; Settings changes the defaults.

## Keyboard

| Key | Does |
| --- | --- |
| `j` or `↓` | Next PR, with its briefing |
| `k` or `↑` | Previous PR |
| `b` | Brief me on this PR |
| `o` | Open this PR on GitHub |

## Security

The UI's server can use your GitHub sign-in and spend your model budget, so it's locked down:

- It listens on 127.0.0.1 only, so other machines can't reach it.
- Every API call needs the session key in the link `alden ui` prints. The key travels in the link's `#fragment`,
  which browsers never send to servers. The UI keeps it for that tab only and takes it out of the address bar.
- Calls must come from the server's own address, which stops other websites, including through DNS rebinding.
- Pages get a strict Content Security Policy and don't send referrers.

Don't share the link while `alden ui` is running. A new run makes a new key.

## Working on the UI

See [`packages/ui/README.md`](../packages/ui/README.md). `pnpm ui:demo` serves the UI over the recorded public PRs,
with no GitHub or model calls, for UI work and screenshots.
