# alden

## 0.7.0

### Minor Changes

- 47a553c: Alden notes which of its places you actually saw, so it can learn from what your reviews pass without a word: a guided review step in front of you for 1.5 seconds, or an **E1**, **E2**… marker in the Diff tab on screen for 1.5 seconds. Each place is kept once per PR and head commit, for 90 days and the last 200 PRs, on your machine only: never in usage stats or the feedback export, and never for **My changes**. Settings → Learning has **Learn from my reviews** (`learning.fromReviews`, on by default) to turn it off. The Memory view says where a learned item came from ("from your review of acme/shop#412, Oct 8", "and 3 more"), and after you send a review the Comments drawer says in one line what Alden learned from it.
- cb5f3c6: A model finding raised because of one of your notes now says so: "Because of your note: Every file needs a code owner header", in the briefing, guided review, the terminal and `alden_review`. Each note goes to the model with a short id for that review, and Alden keeps the link only when the model names one of those ids, so text in a PR can't pass itself off as your note. Reacting to such a finding teaches the note, not a check: **Useful** confirms it (Memory shows "confirmed 3×"), and after **Not useful** `alden ui` offers **Stop applying this note to app/api?** or **Edit the note**; without either, nothing changes. A note you stop under a folder or file isn't sent for changes there, and the model is told where it doesn't apply for changes that are partly there. `alden memory` lists where each note is stopped, and `alden memory exclude <id> <path>` / `alden memory include <id> <path>` change it from a terminal.
- 3681719: Alden learns from what comes of your reviews. When a PR's author applies a suggestion you sent, or resolves a comment of yours (or a push makes it outdated), that's recorded once as an outcome, with the check of the flagged place it was near, and counts toward that check's lesson (2 for an applied suggestion, 1 for a resolved comment, once per PR per topic, on top of the review's own signals). Alden checks the PRs you reviewed in the last 14 days at most once a day each (one GitHub request per PR, in the background after a queue refresh, and on `alden feedback`), and `alden feedback` says "Outcomes: 3 suggestions applied, 2 comments resolved (last 14 days)". Set `learning.fromReviews = false` to turn it off.
- b738169: Alden learns from the reviews you send, not only from Useful and Not useful. A comment near a flagged place counts toward that check's lesson (2 when the review requests changes or the comment suggests a change, 1 for a plain comment), approving past a place Alden knows you saw counts 0.2 the other way (never for secrets, AI-aimed text or high and critical flags, and never enough to quieten a check without a Not useful of yours), a comment where Alden flagged nothing is noted as a miss, and the code areas you comment in rank higher in your queue. A comment near a finding that came from one of your notes confirms the note instead, and teaches no check. One review can't teach a lesson on its own: a PR counts once per topic, at its strongest signal. `alden send` says what the review moved ("2 of 3 (2 from your review of acme/shop#412): one more useful on untested-change flags…"), `alden memory` and `alden_memory` name the reviews a lesson came from, and `alden feedback` counts review signals apart from your clicks. Turn it off with `learning.fromReviews = false`. This replaces 0.4's "useful via comment", which still counts.

## 0.6.0

### Minor Changes

- 5508df2: Your comments collect in a drawer beside the briefing, so it's always clear where they'll post. **Comments · 3** (or `s`) in a PR's toolbar opens it: your drafts grouped by where they go, **On lines** (file and line or range) and **In the review body** (general notes), then **Add a general note**, the review body, and the verdict with **Send review** always in view at the bottom, with the same summary before anything posts. **Comment** on a place, or `c`, opens one editor there that names its target ("Comment on py/orders/pricing.py, line 4"). **Suggest a change** adds code that posts as a suggested change the author can accept on GitHub, and **Comment on a line…** takes a range like `4–9`. The drawer stays as you left it for the window, and becomes a full-width sheet in narrow windows. It replaces the Review panel at the bottom of the briefing, in the web UI and the desktop app.
- 57f7978: A Diff tab beside each briefing in the web UI and the desktop app (`d` switches): the PR's code itself, or your uncommitted changes, file by file with old and new line numbers, so you no longer switch to GitHub to read it. Alden's places to look are marked E1, E2… at their lines (`]` and `[` go from one to the next) and your comments show as badges; a place's file:line in the briefing opens the diff there, with GitHub's link kept beside it. Renames, binary files and diffs too large for GitHub to send say so, large diffs stay quick (rows render as you scroll, big files start collapsed), and a PR's diff is kept per push so reopening it is instant. Behind it, `GET /api/diff` in the local API.
- 990ac26: Guided review. In the web UI and the desktop app, **Start guided review** (or `g`) takes a briefing's places one at a time: why each is there, the code at it from the PR's diff, and **Look at these too**, the files worth opening beside it. Each step keeps Useful, Not useful and Dismiss, `n` and `p` move between steps, `Esc` leaves and you can resume where you were, and the model's other findings follow as extra steps. The related files come from the code graph the briefing already built, at no extra cost: other callers of the changed code, tests that call it or import its file, and files importing it. They show under each place in `alden review`, in `alden review --markdown` and in what `alden_review` gives your AI coding tool, and in the briefing's JSON as `related` on each place.
- 7fd58ea: A comment on code GitHub won't take an inline comment on (a line outside the PR's diff, a file the PR doesn't change, a whole file) becomes a linked note instead of an error: a general note in the review body that starts with a link to that code at the PR's head when you wrote it, like **[`py/orders/tasks.py` line 5](…/blob/<sha>/py/orders/tasks.py#L5)**: your text. The editor says so before you save ("This line isn't in the PR's diff, so it goes in the review body with a link to it."), and the drawer lists it under **In the review body** with "links to py/orders/tasks.py, line 5". A suggested change in one posts as code headed "Suggested change" for the author to copy. `alden comment` and Claude Code's `alden_draft_comment` do the same and say so, after checking the file and line exist at the head. What the model also noticed, and the model's extra steps in guided review, get **Comment** too.
- d4d763b: Suggest changes the way GitHub does: `alden comment <pr> src/pay.ts:12-14 "text" --suggest "code"` (or `--suggest-file <path>`, or `--suggest -` for stdin) drafts a suggested change the author can apply with a click, and `file:12-14` alone writes a comment on several lines. Ranges are checked against the PR's diff (one hunk, one side) when you write them. A suggestion follows its lines across pushes only when every line is found again unchanged; otherwise it's outdated, so it never applies to code it wasn't written against. `alden comment <pr>` and `alden send` show each suggestion as the lines it replaces and the lines it suggests, and code containing backticks is fenced so it can't break the block. Claude Code can draft suggestions too: `alden_draft_comment` takes `start_line` and `suggestion`. A suggestion sent near a flagged place counts as "useful", like a comment.

## 0.5.0

### Minor Changes

- 7b4dc8a: Export a briefing instead of screenshotting it. `alden review <pr> --markdown` prints it as a Markdown document to share or save (`> briefing.md`): the PR and its link, what it does, where to look with file and line, every check with its evidence, callers, what wasn't checked, and the model and its cost. In the web UI and the desktop app, **Export** (or `e`) in the briefing's toolbar copies the same Markdown, saves it as `owner-repo-123-briefing.md` (the desktop app saves to your Downloads folder and says where), or prints it, with a print layout that drops the queue and buttons so it saves cleanly as a PDF. Your memory notes stay out, and secrets stay masked. In the desktop app, "Briefing ready" now plays the system's notification sound; turn it off in Settings → Notifications or with `alden config set notifications.sound false`.
- 69a9acf: Briefings keep up with the base branch. For a PR, callers are now found in GitHub's merge of the PR onto its latest base (what CI tests), so a caller added or a file moved on main since the PR branched is found; what counts as changed is still the PR's own diff. When the PR conflicts, or GitHub hasn't made the merge yet, callers come from the PR's branch and the briefing says so. Each PR briefing records the commits it was made against, and `alden review` ends with "Callers from main at abc1234 + this PR". In the web UI and desktop app, the briefing says when it was made ("Briefed 30 min ago") and, once the PR or its base has moved on, what changed with **Re-brief** ("main has 4 new commits since"). Background briefings are served only while they still match the PR's head and base, and are prepared again when they don't.
- ba197c5: Find a PR in a big queue quickly. In the web UI and the desktop app, `/` searches the queue (title, repo, `#number`, author, branch), a row of filters narrows it by repo, author (you, people, bots, AI agents), how you were asked (you or your teams), assignee, label, drafts, CI and age, and Sort puts it in rank, oldest-first, longest-waiting, last-updated or smallest-first order inside each lane. The count says "12 of 144", **Clear filters** goes back to everything, and filters and sort are remembered. `[` (or «) collapses the queue to a thin rail so the briefing takes the full width. `alden queue` gains `--author`, `--label`, `--search` and `--sort`, and each PR's facts now include its assignees.
- fef649e: Choose how your queue ranks, and have the desktop app brief by it. Every signal the queue ranks by is now a weight you can turn up, down or off under `[queue.rank]` (`urgentLabel`, `stacked`, `sameAuthor`, `ownsFiles`, `waiting`, `size`, `risk`, `noTests`, `learned`; 0 ignores one, 1 is the default, 2 doubles it), and rules put PRs first or last in their lane, or boost or lower them, by path, label, author (a login, or people, bots or AI agents), repo, base branch or title. Each rule that applies leads the row's reasons ("↑ your rule: payments/ first"), and what Alden learns never overrides a rule. With nothing set, the order is unchanged. Settings → Ranking in the web UI and the desktop app has a slider per weight, the rules list, and your current queue's top 5 with what's on screen before you save. The desktop app briefs your top PRs in that order, and how many it keeps briefed is now yours to set (`background.prepare`, 0 to 10, default 3). `alden queue --explain` shows each PR's score by weight and rule, and `--json` carries the same breakdown.

### Patch Changes

- d5fd9ff: In the desktop app, Settings' "Export redacted feedback" saves the file to your Downloads folder and says where, as Save as Markdown does for briefings; the app's window can't download files, so before it did nothing.
- c0772f5: In the desktop app, links to PRs, files on GitHub and docs open in your default browser; before, clicking them did nothing, because the app's window can't open tabs. And a long note after marking a model finding useful no longer squeezes the finding's text into a narrow column: it wraps under the buttons.

## 0.4.0

### Minor Changes

- b646c29: Comment from Alden: write comments on a PR in Alden (`alden comment <pr> [file:line] "text"`, or in the web UI), and send them to GitHub as one review that comments, approves or requests changes (`alden send <pr> --comment | --approve | --request-changes`). Alden shows exactly what will post and asks first; it posts only what you send, never in the background, from a model or from Claude Code. Comments follow their lines when the PR gets new commits, or are marked outdated when a line changed. Claude Code can draft comments with the new `alden_draft_comment` tool, and has no tool to send. A comment you send near a flagged place counts as "useful" on it. `alden doctor` says whether your sign-in can post reviews. Drafts stay on your machine and are never in usage stats or the feedback export.
- 85278a0: Comment from Alden in the web UI and desktop app: comment on places, evidence lines or any changed line in a briefing, see Claude Code's drafts marked "from Claude", and send them all to GitHub as one review after a summary of exactly what will post.
- a51225c: Set up a model in about a minute. `alden setup` offers three choices: paste an Anthropic API key (Alden checks it with one tiny request, which costs a fraction of a cent, says why one doesn't work, and stores it in the keychain), use a local model through Ollama (it recommends a coder model for your machine's memory, downloads it with progress if needed, and writes the config), or checks only. In the web UI and the desktop app, "No model set up" becomes **Set up a model**, with the same choices and no restart afterwards. `alden doctor` suggests `alden setup` when there's no model, and the first run mentions it once.

### Patch Changes

- 50e2681: In a briefing's "Needs your eyes", a file that still imports a moved or deleted module by its old path is headed "Still imports the old path in <file>" instead of "Caller of changed code in <file>". Callers of changed functions keep their title.

## 0.3.2

### Patch Changes

- e1f64df: `alden review <n>` says which PR the number picked from your last queue, and, inside a clone of another repo, how to review that repo's PR with the same number. In the web UI and desktop app, a PR you dismissed shows normally again when it changes and comes back, instead of staying struck through until the window reopens.

## 0.3.1

### Patch Changes

- 4d0b0f8: `alden auth model` and the Settings key field accept every kind of Anthropic API key, not only those starting `sk-ant-api`. Claude.ai sign-in tokens and Admin keys are still refused.
- 4d0b0f8: The web UI and desktop app strip escape codes from PR titles, branches and paths too, as the terminal does since 0.3.0.

## 0.3.0

### Minor Changes

- 84ee6fa: Sharper checks: a `critical` severity for likely secrets and migrations that can lose data; a new "Text aimed at AI
  reviewers" check; moved and deleted files flag the files still importing their old path, and show where they moved
  from; comment-only changes and pure moves no longer count as untested code; package.json `resolutions` and
  `overrides` count as dependency changes; callers in code take places before callers in tests; and Python callers
  through `from .services import product_sync` are found.
- 0e63f1c: PR briefings find callers in your clone of the PR's repo wherever Alden runs: it remembers each clone it runs in, and
  searches the folders in the new `clones.folders` setting (e.g. `~/src`). The web UI says which clone callers came from.
- e23c95d: `alden completion zsh|bash|fish` prints a tab-completion script for every command and flag (`alden completion --help`
  says how to install it). In a terminal, `alden queue`, `alden review` and `alden doctor` end with a dim "Next:" line
  suggesting the obvious next command; never with `--json` or in a pipe. `alden queue`'s "Open one with `alden open
  <#>`" line moves into it, so piped output no longer ends with a hint.
- 8f43f9f: Learning you can see, about the PRs that matter now. The queue learns code areas ("you open PRs touching app/api
  first") and who wrote a PR: you, people, bots or AI agents (Copilot, Claude, Devin, Cursor, Codex and more), and which
  one ("you usually skip Dependabot PRs"). Every useful or not useful says how close it brought a lesson ("2 of 3: one
  more not useful on API change flags and Alden will quieten them"), in `alden ui`, `alden_feedback` and `alden feedback`.
  Quietened checks say so in the checks list, the model is told to stop raising them, and model findings tagged with a
  topic teach the same lessons as the checks. Changed signatures and callers outside the diff now count as one API change
  lesson, and learning text says useful and not useful throughout.
- 85f4677: `alden auth model` stores your Anthropic API key in the keychain (asked for without showing it, or read from standard
  input), so the desktop app, `alden ui` and `alden mcp` find it too; `--remove` takes it out, and Settings has a
  write-only field for it. `alden auth status` and `alden doctor` say where the key comes from, never the key. The order
  is ANTHROPIC_API_KEY (and the other Anthropic variables), then the stored key, then an `ant auth login` profile.
- fb8c6aa: The queue loads about three times faster: the search only fetches ids, and PR details, CODEOWNERS and stacked counts
  load side by side (`ALDEN_DEBUG=queue` shows where the time goes). Major dependency bumps now rank higher, with a reason
  like "major bump: nesbot/carbon 3 → 4". The web UI and desktop app show the last queue at once while a fresh one
  loads, fetch the whole queue so the repo filter lists every repo, and each PR shows one waiting time: since you were
  asked.

### Patch Changes

- 9f2ae1c: Evidence under Checked in `alden review` wraps instead of being cut at the terminal's edge, and a changed signature
  shows its old and new forms on lines of their own, with the part that changed in colour.
- fe94827: Desktop and web UI fixes: clicking Alden in the Dock brings the window back; choosing a repo folder says where callers
  now come from and shows that repo's PRs (with Show all repos); "I've signed in" says what failed (the keychain refused,
  GitHub rejected the token, or no sign-in anywhere) instead of doing nothing; the Settings toggles fill their box; and
  `release:dry-run --desktop` unregisters and deletes the unsigned Alden.app it built, which could open instead of the
  installed app.
- 570978a: With `--include-drafts`, `alden queue` tags each draft `[Draft]` before its title and dims its row, so drafts stand out
  from PRs ready for review.
- cb9ad7e: `alden queue` shows what it's doing while it works ("Checking acme/shop (2 of 5)…", "Seeing what needs your eyes…"),
  on standard error and only in a terminal, instead of looking hung.
- 76b5fec: Escape sequences in PR titles, paths, branch names and bodies are removed whole, so a title like `\e[31mFix\e[0m`
  shows as "Fix", not "[31mFix[0m". Links, window titles and clipboard writes go the same way; accents and emoji stay.

## 0.2.3

### Patch Changes

- Choose how many places "Needs your eyes" holds: `review.eyes`, 1 to 10 (3 by default), in Settings or with
  `alden config set review.eyes 5`.

- When the model's thinking uses up all its room before it answers (one PR in six in the latest eval, whatever the
  PR's size), Alden now asks once more with low effort and less room, within what's left of your per-review cap (sending only the files that fit, for
  a big PR), instead of discarding the review. The briefing says when it did. Failed model calls now say what went wrong.

- Set what your queue covers on each machine: `queue.orgs`, `queue.repos` and `queue.ignore` in your user config (or
  Settings → Your queue on this machine). Only your company's organisation on a work laptop, only your own repos on a
  personal one; the terminal, the web UI, the desktop app and `alden mcp` all follow it, `--repo` and `--org` override
  it for one run, and a repo's `.alden.toml` can't change it. Doctor shows the scope, and only warns about
  organisations inside it. `alden config set` takes comma-separated lists.

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
