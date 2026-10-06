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
| `--json` | Print one JSON line with the link and port, and don't open a browser. The desktop app uses it, and it turns on background briefings. |

Stop it with Ctrl+C.

## Views

- **Queue.** "Needs you" and "Fast-track", with each PR's wait, size, CI and the reasons it ranks where it does (a
  line marked ↑ or ↓ when your own feedback moved it). The selected row takes **Useful**, **Not useful** and
  **Dismiss** (hidden until it changes). Filter by repo, refresh, and pick a PR to see its briefing beside the list.
  The UI fetches your whole queue (up to the 1,000 PRs a GitHub search returns), so the repo filter lists every repo
  in it. On opening, it shows the last queue at once (kept for a day), marked "As of 3 min ago, refreshing…" until
  the current one arrives.
  Until you've answered, a card at the top asks whether to send [anonymous usage stats](telemetry.md). In the desktop
  app, PRs briefed while you were away are marked "Briefing ready".
- **A PR.** Above the briefing, which clone its callers come from (when it isn't the folder `alden ui` runs in), or that
  there's none, with how to point Alden at your clones (`clones.folders`). "Brief me" runs the review and shows each stage as it goes (fetching, finding callers, checks, the
  model). The briefing follows the CLI's order. Every place links into the PR's "Files changed" view at that line.
  A review keeps running if you look at another PR, and its briefing is there when you come back. **Useful** and
  **Not useful** on each place, finding and flagged check teach Alden; **Dismiss** hides one place on this PR. "Shaped
  by your feedback" says what your feedback changed. Briefing a PR from
  the queue counts as opening it, for learning.
  Under the title, when it was briefed ("Briefed 30 min ago"), and once the PR or its base has moved on, what changed
  and **Re-brief**: "main has 4 new commits since" (callers merged there since aren't in it) or "the PR has 2 new
  commits". Alden asks GitHub (one request) when the briefing is shown and when the window comes back to the front, at
  most once a minute; it doesn't poll. See [Keeping up with the base](code-graph.md#keeping-up-with-the-base).
- **Comment from Alden.** Write your review in the briefing and send it to GitHub as one review. **Comment** on a place
  in "Needs your eyes" or on a flagged check's evidence line opens an editor there; **Comment on a line…** takes any
  line of a changed file (pick the file, give the line; a removed file's line is on the old side), and **Add a general
  note** writes one that goes into the review's body. Comments are drafts, kept on this machine, until you send them.
  The **Review** panel at the bottom of the briefing lists them by file, with Edit and Delete. Drafts that Claude Code
  added are marked "from Claude", so you read them before they go out under your name; Claude can add drafts but never
  send them. A draft written before the PR's latest commits is marked **Outdated**: **Rewrite** puts it in a new
  comment on the current code (check the line), or delete it; the review won't send until you've done one or the
  other. Then the review body, the verdict (**Comment**, **Approve** or **Request changes**, which needs a body) and
  **Send review · 3 comments**. Nothing posts yet: a summary shows exactly what will, the PR, the verdict, the body
  (yours, then your general notes) and each comment with its file and line. Before **Approve** it also lists the places
  Alden flagged that you didn't comment on. Only the button there sends it. Afterwards the panel says "Sent to GitHub"
  with a link to the review; if GitHub refuses, it shows why and keeps your drafts. A PR you've opened in this window
  shows "2 drafts" in the queue while it has some.
- **My changes.** Your uncommitted changes in the repo `alden ui` started in, before you open a PR.
- **Stats.** Time to first review and cycle time for a repo, before and after you started using Alden.
- **Memory.** Each repo Alden knows about, then what you look for and what you skip there: where each item came from,
  what it changes, Edit (notes), Forget and Undo, a switch to pause learning, and "Tell Alden something" to add a note.
  See [Learning and memory](memory.md).
- **Settings.** The default model, effort and caps (saved to your user config), your Anthropic API key (stored in the
  keychain like `alden auth model`; the field is write-only and the page only learns where the key comes from), what
  your queue covers on this machine
  (organisations, repos, and what to leave out; the queue says when it's narrowed), your feedback with a redacted export,
  usage stats on or off, today's spend by PR, and light, dark or system appearance. In the desktop app, "While you're
  away" turns [background briefings](desktop.md#while-youre-away) and their use of the model on or off, and "Command
  line tool" installs the `alden` command if it isn't there.
- **Sign-in.** When Alden isn't signed in to GitHub, or GitHub no longer accepts its sign-in, the queue offers **Sign in
  with GitHub** (a one-time code, with GitHub's page opened for you) and, when the GitHub CLI is signed in, **Use my
  GitHub CLI sign-in**. No terminal needed. If you signed in in a terminal instead, **I've signed in** looks again and,
  if Alden still can't see a sign-in, says what failed: the keychain refused to answer (as it does for an unsigned
  development build of the desktop app), GitHub rejected the token, or there's none anywhere.

With no model, the briefing options offer **Set up a model** instead of asking the model. It opens the same three
choices as `alden setup`, in the same order: paste an Anthropic API key (checked with one tiny request, which costs a
fraction of a cent, then stored in the keychain; the page never gets it back), use a local model through Ollama
(recommended for your machine's memory, downloaded with progress if needed; local models flag less than Claude), or
checks only. Then a line for [Alden Cloud (beta)](https://getalden.dev/cloud). The next briefing uses the new model,
with no restart.

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
| `+` `−` `x` | Useful, Not useful, Dismiss on this PR |
| `c` | Comment on the place you're on in the briefing (a place in "Needs your eyes" or an evidence line), or else open "Comment on a line…" |
| `s` | Go to the Review panel |
| `⌘↵` / `Ctrl+↵` | Save the comment you're writing |
| `r` | Refresh the queue |
| `Esc` | Cancel the comment you're writing, or leave the send summary; stop a running briefing; in a narrow window, back to the list |

Keys never fire while you're typing in a text box.

Below 960px wide the list and the briefing take turns: pick a PR to open its briefing, and "← Queue" or `Esc` goes back.

The look comes from the "Alden App v2" Claude Design project: light and dark (following the system unless Settings
picks one), Geist and Geist Mono, served from Alden itself (the fonts are bundled under the SIL Open Font License).

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
with no GitHub or model calls, for UI work and screenshots. Every route of the local API is listed in
[Architecture](architecture.md#the-web-uis-server).
