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
  **Dismiss** (hidden until it changes). Search, filter and sort it (below), refresh, and pick a PR to see its briefing
  beside the list. On opening, it shows the last queue at once (kept for a day), marked "As of 3 min ago, refreshing…" until
  the current one arrives.
  Until you've answered, a card at the top asks whether to send [anonymous usage stats](telemetry.md). In the desktop
  app, PRs briefed while you were away are marked "Briefing ready".
- **Finding a PR in the queue.** The UI fetches your whole queue (up to the 1,000 PRs a GitHub search returns), so
  search and every filter cover all of it.
  - **Search** (`/`) matches the title, repo, `#number`, author and branch names; every word has to match, and
    `@sam` means the author sam. `Esc` clears it and goes back to the list; `Enter` opens the first match.
  - **Filters**, one row of menus under the search: repo, author (you, people, bots or AI agents, the same
    [kinds](queue.md#bots-and-ai-agents) learning uses), how you were asked (you by name, your teams, or one team),
    assignee (you, unassigned, or someone), label, drafts (hide, or only drafts, when the queue has any), CI (passing,
    failing, running, none) and age (opened today, this week, or before). They combine, a filter that's on is
    highlighted with its value, and the line below says "12 of 144" with **Clear filters**.
  - **Sort**: Alden's rank (the default), open longest, waiting longest on you, recently updated, or smallest first for
    quick wins. It sorts inside Needs you and Fast-track separately, and dismissed PRs stay at the bottom. Each row
    keeps its number from Alden's rank.
  - `j` and `k` move through the queue as it's shown. Filters and sort are remembered in this browser (the desktop app's
    window keeps its own) until you reset them; the search isn't.
  - **Collapse** (`«` or `[`) folds the queue into a thin rail so the briefing takes the full width; `[` again, or a
    click on the rail, brings it back. `/` and `j`/`k` still work while it's folded. Remembered like the filters. Below
    960px wide, where the list and the briefing already take turns, there's nothing to collapse.
- **A PR.** Above the briefing, which clone its callers come from (when it isn't the folder `alden ui` runs in), or that
  there's none, with how to point Alden at your clones (`clones.folders`). "Brief me" runs the review and shows each stage as it goes (fetching, finding callers, checks, the
  model). The briefing follows the CLI's order. Every place opens the Diff tab at that line, and links into the PR's "Files changed" view on GitHub.
  A review keeps running if you look at another PR, and its briefing is there when you come back. **Useful** and
  **Not useful** on each place, finding and flagged check teach Alden; **Dismiss** hides one place on this PR. "Shaped
  by your feedback" says what your feedback changed. Briefing a PR from
  the queue counts as opening it, for learning.
  Under the title, when it was briefed ("Briefed 30 min ago"), and once the PR or its base has moved on, what changed
  and **Re-brief**: "main has 4 new commits since" (callers merged there since aren't in it) or "the PR has 2 new
  commits". Alden asks GitHub (one request) when the briefing is shown and when the window comes back to the front, at
  most once a minute; it doesn't poll. See [Keeping up with the base](code-graph.md#keeping-up-with-the-base).
- **Diff.** Once a briefing is there, a **Briefing | Diff** switch sits above it (`d` switches). **Diff** shows the
  code itself, so you don't have to go to GitHub to read it: every changed file, with its `+`/`−` counts, "old →
  new" for a rename, and a note for a binary file or one whose diff is too large for GitHub to send (with a link to it
  on GitHub). Each file opens and closes from its header (or `f`); **Collapse all** folds them all. Lines are unified,
  with the old and new line numbers. Alden's places to look are marked **E1**, **E2**… at their lines (a place on a
  whole file sits in its header), and your comments with a ✎ badge; hover one for its text, or click it to open the
  text under the line. `]` and `[` go to the next and previous place. In the briefing, a place's `file:line` opens the
  Diff tab at that line, highlighted; the **GitHub ↗** beside it still opens GitHub's diff. For a PR, the diff is the
  PR's latest push; if that's newer than the briefing, a line above it says so, since places may have moved. For **My
  changes**, it's your uncommitted changes, as the briefing read them. Large diffs stay quick: rows render as you
  scroll to them, and files over 400 lines of diff start collapsed with **Show**. Alden keeps a PR's diff per push
  while `alden ui` runs, so switching back, or opening the PR again, is instant. The window remembers which of the two
  you were on, until you close it.
- **Export.** Once a briefing is there, **Export** (or `e`) in its toolbar copies it, saves it or prints it:
  **Copy as Markdown** puts the same document as [`alden review --markdown`](commands.md#alden-review) on the
  clipboard; **Save as Markdown** downloads it as `owner-repo-123-briefing.md` (in the desktop app, which can't
  download files, Alden saves it to your Downloads folder and says where, adding `-2` rather than replace a file);
  **Print / Save as PDF** opens the print dialog, where your system offers PDF. The printout is the briefing alone, in
  light colours: no queue, toolbar or buttons, and places and checks don't split across pages. The Markdown leaves out
  your memory notes and what your feedback changed, keeps secrets masked as the briefing shows them, and ends with the
  model, its cost and when it was briefed. A line beside the button says what happened ("Copied as Markdown.").
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
  usage stats on or off, today's spend by PR, and light, dark or system appearance. **Ranking** sets
  [how the queue ranks](queue.md#your-ranking): a slider per weight (0 to 3 here, off at 0, ×1 the default; Reset puts
  them all back), your rules (add, edit, delete and reorder; each takes any of a path, label, author, repo, base branch
  and title, and puts PRs first or last or boosts or lowers them), and "Top 5 with these settings", your current queue
  re-ranked as you change them, each PR's move against your saved settings beside it. Nothing applies until **Save
  ranking**; **Discard changes** goes back. Without a queue to rank (signed out, offline) the preview says why. The
  rules' reasons show on the queue's rows, marked as yours ("↑ your rule: payments/ first"). In the desktop app,
  "While you're away" turns [background briefings](desktop.md#while-youre-away) and their use of the model on or off,
  "Notifications" turns the sound for "Briefing ready" on or off, and "Command line tool" installs the `alden` command
  if it isn't there.
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
| `d` | Switch between the briefing and its Diff tab |
| `]` `[` | In the Diff tab: next and previous place to look (E1, E2…) |
| `f` | In the Diff tab: open or close the file you're in |
| `e` | Open the Export menu (`↑` `↓` move, `↵` picks, `Esc` closes) |
| `⌘↵` / `Ctrl+↵` | Save the comment you're writing |
| `r` | Refresh the queue |
| `/` | Search the queue (opens it first if it's collapsed); `Esc` clears the search, `Enter` opens the first match |
| `[` | Collapse the queue to a rail, or bring it back (windows 960px and wider; in the Diff tab, `[` is the previous place) |
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
