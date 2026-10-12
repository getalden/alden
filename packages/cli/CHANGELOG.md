# alden

## 0.9.0

### Minor Changes

- 692cfdc: The queue recognises an AI agent's PR that a person opened from the marker the agent left: Claude Code's "Generated with Claude Code" footer, a `Co-authored-by` trailer from Claude, Copilot, Cursor, Devin, Jules, Amazon Q, OpenHands or Aider in the last commit, or a link to a Devin, Codex, Cursor or Jules run. It counts for the agent and the person, and the row says how Alden knew ("by Claude (from its last commit)"). Alden reads the description and last commit only for people's PRs, remembers the answer by head commit, and keeps only which agent it found.
- f9e5cb2: Ask your model a question about a PR: `alden ask <pr> "Does anything still read the old column?"`, or `POST /api/ask` in the UI. It answers from the PR's latest briefing of its current push, the diff around the places that matter and your notes, streaming the answer as it's written, in one call within your caps (recorded in `alden spend` as `owner/repo#12 question`). The PR's text goes to the model fenced as data, a PR with text aimed at AI reviewers isn't sent, and answers aren't stored: the last five on a PR stay in the running app for follow-ups. See [Ask about this PR](https://getalden.dev/docs/models#ask-about-this-pr).
- c6bc736: Pick how Alden writes the comments it drafts: terse (one line, no reasoning), concise (the default), detailed (why, the impact and a fix) or teaching (for newer teammates). It's a style for Alden's drafts, not an imitation of you. Set the default with `alden config set drafts.tone detailed`, give a repo its own on this machine (`PUT /api/tone`, the UI's Tune), or pick one for one call with `alden comment <pr> --draft --tone terse`. The briefing's drafts, Draft my review and Draft with Alden all use it; every tone keeps the same rules (the PR's text treated as data, never an approval, never sent untouched). See [The tone of drafts](https://getalden.dev/docs/models#the-tone-of-drafts).
- 21de1de: **First run**: with no GitHub sign-in yet, the web UI and the desktop app open on three short steps, one screen each: sign in with GitHub (saying it asks for the `repo` and `read:org` scopes), choose how Alden thinks (your API key, Anthropic or OpenAI, a local model through Ollama, or checks only), then how many PRs are waiting on you and the top four, with **Open the queue**. **Skip setup** leaves at any step and Settings → **Run setup again** brings them back. `alden` on its own in a terminal, signed out, now walks the same steps in text (sign in, `alden setup`, the queue) instead of stopping at "Not signed in".
- 2b51258: The code graph follows more of how Go code calls itself. A changed method is reached through the repo's interfaces its type implements (marked `name match only`, with the interface named: "through interface GitConfigClient") and through structs embedding its type ("through Server (embeds Base)"). Functions and methods named without a call count as uses: struct fields (`FetchOptions: shared.FetchOptions`), assignments, returns and option lists. Package-level function variables (`var now = func() …`) are definitions their callers reach. Changed unexported functions, methods and types now list their callers in the rest of their package, since a Go package is often dozens of files sharing helpers. Very common method names (`List`, `Patch`, `Status`…) aren't followed through interfaces, and "Callers outside the diff" shows one caller per file before a second from the same file, sure matches before name-only ones. The index format changed, so the first review after updating re-parses the repo.
- 9752296: `alden` on its own in a terminal opens an interactive view: your ranked queue (search with `/`, open with `o`, refresh with `r`), and for any PR its briefing, where `1`–`9` go to a place, `u`/`n` mark it useful or not, `c` writes a draft comment on it, `m` runs the model after saying what it may cost, and `s` shows exactly what `alden send` would post, sent only after Enter and `y`. In a pipe, in CI or with `TERM=dumb`, `alden` prints its help as before, and every command is unchanged. See [Commands](https://getalden.dev/docs/commands#alden-interactive).
- 21de1de: **OpenAI API keys**, first-class: paste an Anthropic or an OpenAI key in `alden setup`, `alden auth model`, **Set up a model** or Settings → API keys and Alden detects which (sk-ant-… is Anthropic's, any other sk-… OpenAI's; Claude.ai sign-in tokens and admin keys are refused). An OpenAI key is checked with one tiny request to `gpt-6-luna`, stored in the keychain under its own name, and makes the new `openai` provider the model (`gpt-6.1-sol` by default; `gpt-6-astra` and `gpt-6-luna` in the picker). `OPENAI_API_KEY` comes before the stored key. Briefings use Structured Outputs in strict mode, `reasoning_effort` on the GPT-6 models, and spend is counted from OpenAI's list prices, cached input apart. `alden doctor` reports both keys, never the key. The local API gains `GET /api/models` and `PUT /api/models` for the model picker: the model in use, and each provider's models, offered only where they're set up here.
- e5da5cd: Alden resolves only threads you started. GitHub lets anyone with write access resolve any thread, but resolving someone else's question for them is theirs to do: in the Comments drawer, a thread someone else started says "ana's to resolve" instead of offering **Resolve when sent**, and `alden comment <pr> --resolve` on one says why and suggests a reply. Replies stay open to every thread you can see, yours or not, as GitHub allows.
- d63465c: Time to review. Alden now records, on your machine, how long each review takes: from first opening a PR's briefing (the web UI, the desktop app, `alden review`, or an AI tool's `alden_review`) to sending the review from Alden. Active time in the UI is how long the PR's pane is visible and focused, leaving out stretches over 2 minutes without input; from a terminal, it's the time from the briefing to the send, at most 30 minutes. Stats and `alden stats` show **Time to review**: median active time and median time from opening to sending, with and without Alden's model, over the last 14, 30 or 90 days by the day you opened the briefing, with how many reviews each rests on and a note when there are fewer than 10. `alden stats --review-time` shows only that, without GitHub. Durations and counts only, never what the PR or your comments say. Turn it off with **Time my reviews** in Settings or `alden config set stats.reviewTime false`. With usage stats on, each sent review adds one `review_timed` event with the times in coarse buckets and the counts, never the PR or repo.
- f077bb1: The Comments drawer has the v3 design: Drafts and Conversation tabs, cards that start with who wrote each draft (you, Alden or Claude Code) and end with its state, Alden's suggestions dashed until you keep them, and "Alden writes" to pick the style Alden drafts in for a repo (Terse, Concise, Detailed or Teaching). Drag its edge to resize it (320 to 760 pixels, remembered), double-click to reset, and `s` folds it to a rail. An outdated draft says which head its lines changed at and offers "Move to new lines" to where its code went now (or "Pick a line"), and the local API lists that as `movedTo` and `changedIn`. "Review and send" opens a summary that counts what posts and what stays behind, leaves outdated drafts out instead of refusing, and on Approve offers "Look first" for each place Alden flagged that you didn't comment on; a sent review says so at the bottom of the window.
- a972530: The web UI and desktop app read a PR in one direction, as in the v3 design. The brief opens with what the PR does, then the places that need your eyes as cards (E1, E2… with how severe, where and why); the first is open with its code, **Comment**, **Walk through from here**, and Useful, Not useful and Dismiss. The model's other findings, the checks, what wasn't checked and the files changed fold into four rows with a line each, and how your feedback shaped the brief is one line under them. **Walk through** (`g`) takes the places one at a time in place of the brief, with step dots, the code, **Look at these too**, **Comment here**, Previous and Next, and **Finish: review your comments** on the last step. The Diff tab says which file you're reading ("file 2 of 6"), sums up each file's places and drafts in its header, and shows places, your drafts and review threads as cards under their lines.
- 14a5cfc: The web UI and the desktop app take on the v3 design's frame. The top bar is 44px, with Queue, My changes, Memory and Stats, today's spend ("$1.84 of $5.00 today"), and your avatar, whose menu has Settings, Export feedback and Sign out (which removes Alden's stored GitHub sign-in, as `alden auth logout` does). The queue column is 340px: one search box ("Search 142 PRs"), one Filter button with every filter and the sort in a popover, and groups for Your turn, Ranked for you and Fast-track, with two-line rows (title and wait, then CI, repo, author and plain flags such as re-review, ✎ 2, XL, draft, agent or bot); why a PR ranks where it does, and Useful, Not useful and Dismiss, show on the selected row. A PR's header reads the briefing in three numbered steps, 1 Brief, 2 Walk through (`g`) and 3 Diff (`d`), beside Comments and Draft my review, and its age line says "briefed 30m ago · main +4 commits" with Brief again and Export. The model line there ("sonnet-5 · medium ▾") opens Tune: the model by provider, how Alden writes, effort, callers, the per-brief cap, and a question for the model about the PR, answered as it streams. In the desktop app the top bar is the window's title bar. Light mode is derived from the new dark palette.
- 9bfc2c2: **Your turn** in the queue: the PRs you reviewed where something happened you haven't seen (replies to your comments, threads resolved, your comments made outdated by a push), at the top of the web UI's and the desktop app's queue and of `alden queue`, each with one line ("Ana replied to 2 of your comments · 1 resolved") and when it happened. Open one and it goes to the PR, with the Comments drawer's Conversation open on the thread the news is in; once opened, it leaves Your turn. A PR that's still in your queue (a re-review is always there, under Needs you with its Re-review label) gets the news on its own row instead, so no PR is listed twice. It shares its news with the desktop app's notifications: a notification you've seen still leaves the PR under Your turn until you open it, and opening it first means you aren't notified. A PR's follow-up level applies: Off hides its news, Re-review only leaves just the re-review row. The web UI and `alden queue` now run the same follow-up check as the desktop app with its limits (one read-only request at most once a minute, and a PR's threads read only when it changed), and nothing when every level is Off. `alden queue --json` has the group as `yourTurn`, and each row's `followUp.news`; `alden open` takes a PR's name too (`alden open acme/shop#12`).

### Patch Changes

- e3d8d3c: Ask's answers read as Markdown in the web UI and desktop app (lists, bold, code, links), and the model's summary and findings show inline code, without ever turning text from a PR into HTML.
- 9fef9e4: `alden review` no longer hangs in a terminal only a few columns wide: a flagged check's evidence wrapped forever below 9 columns. It now wraps at any width.
- dd89f8b: The model picker offers Claude Sonnet 5.5 and Claude Haiku 5.5, and Alden knows their prices for the spend caps. The default stays claude-sonnet-5.
- 065a277: The Claude Code plugin's review skill, its docs and the briefing Claude reads say Alden reviews with you, using what you care about, rather than "the way you would".

## 0.8.0

### Minor Changes

- a5c8194: Alden drafts your review when a model is set up. The briefing's own model call (any model: your own key, a cloud provider or a local model, on every plan) also drafts a comment, and a suggested change when the fix is small and certain, for up to five of its medium and high findings on changed lines. They wait in the Comments drawer marked "Drafted by Alden", with Keep, Edit and Drop, and Keep all / Drop all; the briefing marks each finding "Draft ready". Nothing is sent until you keep or edit a draft and send your review ("2 drafts by Alden not kept won't be sent"), and a draft never approves. Briefing the PR again replaces only the drafts you didn't touch, and a PR with text aimed at AI reviewers gets none, with the reason in the briefing. Keeping or editing one counts once as a comment near the finding's place, and dropping one counts a little the other way (never for secrets or AI-aimed text). `alden review` says "Alden drafted 3 comments — see them with `alden comment <pr>`", `alden comment <pr> --keep <id|all>` keeps them, and **Draft comments for me** in Settings (`drafts.auto`, user config only) turns it off, which leaves the model's prompt exactly as before.
- ee7c8b1: Draft my review, and Draft with Alden. When a model is set up, **Draft my review** (beside Comments in the briefing, and in the Comments drawer) asks it, in one call within your budget caps, for comments on the PR's places to look, Alden's own checks included, and the model's findings, wherever the briefing drafted none: up to eight, each on its line or as a general note linking there, skipping places that already have a draft or a comment of yours on GitHub near them (and saying how many). They're Alden's drafts like the briefing's: keep, edit or drop each, never sent untouched, never an approval. It says what it made and what it cost, or why it couldn't. **Draft with Alden** in every comment and reply box asks for one comment (or a reply to the thread), from the code there or from what you've written so far, and puts it in the box for you to edit: Use it or Keep mine when you'd written something, Undo, and Cancel while it runs. It saves nothing; what you save is yours. Neither runs on a PR with text aimed at AI reviewers, and the PR's own text goes to the model fenced as data, never instructions. In a terminal, `alden comment <pr> --draft`. Usage stats count a saved comment that Alden drafted (never its text).
- b70cc03: After you review a PR, the desktop app tells you what happened next: replies to your comments, threads resolved, a push that makes one of your comments outdated, and a second review request. One notification per PR ("2 replies, 1 resolved", "Ana asked you to review again"), each piece of news once, with the system's sound unless `notifications.sound` is off. Choose how much in Settings → Notifications or `notifications.followUps`: Off, Re-review only, When it's your turn (the default: a re-review, or every comment you left resolved or answered, once per round) or Every reply. Any PR can have its own level until it's merged or closed: the bell beside its name, or `alden watch <pr> --every-reply` (`--default` to go back; `alden watch` lists them). Alden follows the open PRs you reviewed in the last 14 days, finds them with one read-only GitHub request each refresh, and reads a PR's threads again only when it changed.
- 8b25273: See when you're asked for a second review, and read only what changed since your first. A PR you reviewed and were asked to review again is a re-review: it gets a small bump in Needs you (the new `rereview` weight under `[queue.rank]`, 2 points at 1, 0 ignores it, also a slider in Settings → Ranking and a line in `alden queue --explain`), leads its reasons with "Re-review: you were asked again", and says so on the row: "Re-review · reviewed 2 days ago" in the web UI, `[Re-review]` and "reviewed 2d ago" in `alden queue`. `--json` carries a `followUp` on every PR you reviewed before, with when you reviewed and the commit you reviewed. In the briefing, the Diff tab opens on **Since your review**, the changes from the commit you last reviewed to the PR's head, with **Whole PR** beside it; when that commit was force-pushed away it shows the whole PR and says so. Alden reads all of this from what the queue already fetches, plus one compare request when you open the diff.
- f2d0e7e: Read a PR's existing review conversation in Alden, and answer it with your review. The Comments drawer's **Conversation** lists the PR's threads (yours first, open ones first), each with a **Reply** box and **Resolve when sent**; the Diff tab shows threads under their lines, with **Reply**. In a terminal, `alden comment <pr> --threads` lists them with short ids, `alden comment <pr> --reply <id or file:line> "text" [--resolve]` replies, and `alden comment <pr> --resolve <thread>` resolves one without a word. Replies and resolves are drafts: they go out only with Send (the UI's or `alden send`), whose summary says where each goes ("Reply in thread on src/pay.ts:40, and resolve it"). A review with replies is started pending, the replies added, then submitted with your verdict, and only then are threads resolved; if a step fails before the submit, Alden deletes the pending review so nothing half-posts, and says which step failed. Claude Code's `alden_draft_comment` can draft a reply with `in_reply_to`; it still can't send or resolve.

### Patch Changes

- 17fa8a5: A cancelled CI run no longer counts as failing CI. GitHub's summary calls it a failure, so Alden now reads the runs: a cancelled run of a check that ran again counts as that run, and when a cancelled run is all that kept CI from passing, the queue says **CI cancelled** (`cancelled` in `alden queue`) and the PR keeps its place instead of sinking with "CI failing: ping @author". The CI status check skips it. Any other failed run still makes CI failing.
- f41ff3f: Alden no longer drafts a comment within three lines of a review thread already on the PR (an outdated thread by the line it started on). Briefing a PR again used to draft the same comment you had kept and sent before, on the same line as the thread you were replying in, where it was easy to send by mistake. A reply posts exactly what you wrote in its box.
- 367057c: A long draft in the Comments drawer (yours, Alden's, or a reply) shows its first four lines with **Show all**, which opens the rest where it is, and **Show less**; you no longer have to open it with Edit to read it.
- 79e7c4d: When a model briefing of a PR has no drafts, the briefing says why in one line, and so does `alden review`: "No drafts: Alden drafts comments for the model's medium and high findings on changed lines, and this briefing had none.", or the model wrote no comment for the ones that qualified, or **Draft comments for me** is off (alongside the reason already given for text aimed at AI reviewers).

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
