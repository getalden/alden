# Comments and sending a review

Once Alden has briefed you on a PR, you can say what you think without leaving it: write comments on the places to
look or on any line (or lines) of the diff, suggest changes the author can apply with a click, collect them as a
pending review, and send them to GitHub as **one review** that
comments, approves or requests changes.

Alden posts only what you send. Nothing goes to GitHub until you press Send in the UI or confirm `alden send` in a
terminal: never in the background, never from a model, never from Claude Code. That includes
[replies and resolves](#replying-in-a-thread) in threads already on the PR: they go with your review, never on their
own.

## Writing comments

In [the web UI](web-ui.md) and the desktop app, your comments collect in the **Comments** drawer beside the briefing
(the toolbar's **Comments · 3**, or `s`). **Comment** on a place to look, or `c` on it, opens the drawer's editor on that
place, saying where it goes ("Comment on py/orders/pricing.py, line 4"). The drawer lists your drafts by where they'll
post, **On lines** or **In the review body**, and ends with the review body, the verdict and **Send review**. In a
terminal:

```sh
alden comment acme/shop#7 src/pay.ts:12 "Is fee in cents here?"
alden comment acme/shop#7 src/pay.ts:12-14 "This block runs twice."   # on lines 12 to 14
alden comment acme/shop#7 "Nice cleanup overall."          # a general note
alden comment acme/shop#7                                   # list what's waiting
alden comment acme/shop#7 --delete a1b2c3d4
```

`<pr>` is a PR URL, `owner/repo#123`, or a number from your last `alden queue` (Alden says which PR a number picked).
`file:line` is a line in the new file, and `file:12-14` the lines from 12 to 14; add `--left` for removed lines,
numbered in the old file.

- **A comment on a line** becomes an inline comment on that line, when GitHub takes one there: on lines in the PR's
  diff (changed lines and the few shown around them). Anywhere else it becomes a [linked note](#comments-on-code-outside-the-diff).
- **A comment on several lines** covers a range, as GitHub's own multi-line comments do. GitHub only takes a range on
  one side of the diff and within one hunk (one `@@` block); a range outside that is a linked note too. In the UI,
  give the line as `4–9`.
- **A suggested change** on a comment ("Suggest a change" in the UI, on the new side only) posts after the comment's
  text as a `suggestion` block, which the author can accept on GitHub. The UI starts it from the line's text when it
  has it; left empty, it suggests deleting the line(s). A comment with a suggestion needs no other text.
- **A comment without a line** is a general note. Notes go into the review's body, after anything you write for the
  body itself, oldest first.

## Comments on code outside the diff

Alden often points at code the PR doesn't change: a caller in an unchanged file, a file under **Look at these too**,
a finding about a whole file. GitHub won't take an inline comment there, so a comment on it becomes a **linked note**:
a general note in the review body that starts with a link to that code.

- In the UI, the editor says so before you save: "This line isn't in the PR's diff, so it goes in the review body with
  a link to it." (once it has the PR's diff to check against). The drawer lists the note under **In the review body**,
  with "links to py/orders/tasks.py, line 5".
- In a terminal, `alden comment acme/shop#7 py/orders/tasks.py:5 "Retry here too?"` on a line outside the diff saves
  a linked note and says so.
- From Claude Code, `alden_draft_comment` does the same and tells Claude the draft became a linked note.
- **Comment** on a whole file (a place or finding with no line) is always a linked note, to the file.

In the review body it reads:

```md
**[`py/orders/tasks.py` line 5](https://github.com/acme/shop/blob/4f1c2e9…/py/orders/tasks.py#L5)**: Retry here too?
```

A range links to `#L4-L9` and reads "lines 4–9"; a whole file has no line. Your text follows exactly as you wrote it.
If it starts with a list, a quote or a code block, it goes on the next paragraph instead, so it still renders.

The link is pinned to the PR's head commit **when you wrote the note**: it shows the code you were looking at, even
after the author pushes. Linked notes don't need following when the PR moves, and never go outdated. Hover the note in
the drawer to see the commit.

Before saving one, Alden asks GitHub whether the file is there at the head, and has that many lines: a path or line
that doesn't exist is refused with a sentence saying so, rather than posted as a broken link. A removed line (the old
side, `--left`) outside the diff can't be linked, since it isn't in the file at the head.

**A suggested change in a linked note** can't be applied: GitHub only applies suggestions on lines in the diff. Alden
keeps it rather than dropping it: it follows the text as a code block headed "Suggested change", for the author to copy
(or "Suggested change: delete this line." when it's empty). The editor says so under **Suggest a change**. A whole
file takes no suggestion.

## Suggesting changes

A suggestion is a comment with replacement code for its line or lines. GitHub shows it as a small diff with a
**Commit suggestion** button, so the author can apply it without retyping it.

```sh
alden comment acme/shop#7 src/pay.ts:12 "Cents, please." --suggest "const total = cents(a + b);"
alden comment acme/shop#7 src/pay.ts:12-14 --suggest-file fix.ts    # the replacement for lines 12-14
pbpaste | alden comment acme/shop#7 src/pay.ts:12-14 --suggest -    # from stdin
alden comment acme/shop#7 src/pay.ts:20 "Leftover debugging" --suggest ""   # delete line 20
```

- The replacement is the code exactly as those lines should read, indentation included: no fence, no `+` or `-`.
  From a file or stdin, one trailing newline is dropped (editors add one); anything else is kept.
- An empty suggestion deletes the lines.
- The comment's text is optional with a suggestion.
- Suggestions apply to the new file, so they go on the new side only: not with `--left`, and not on a plain general
  note. On a line outside the diff, the suggestion goes in a [linked note](#comments-on-code-outside-the-diff) as code
  to copy.

What posts is your text, a blank line, then the suggestion in a ` ```suggestion ` block. If the code itself contains a
run of three or more backticks (a Markdown snippet in a doc comment, say), Alden fences it with one more backtick than
the longest run, so nothing in your code can end the block early.

`alden comment <pr>` and `alden send` show a suggestion as the lines it replaces (`-`) and the lines it suggests (`+`).
Alden keeps the replaced lines' text from when you wrote the suggestion, so it can tell whether the code under it has
changed (below).

From Claude Code, ask Claude to draft a comment or suggest a change and it uses Alden's `alden_draft_comment` tool. Its drafts sit with
yours, marked "drafted by Claude Code", and post as you only when you send them. There is no tool for sending. See
[Alden in your AI coding tool](mcp.md).

## Replying in a thread

A PR you come back to already has a conversation: the review threads on its lines, yours and other people's. Alden
shows them, and lets you answer one, or resolve it, as part of the review you send. A reply is a draft like any
comment: kept on your machine, and posted only with Send.

In the UI, the Comments drawer's **Conversation** lists the PR's threads, yours (threads you started or replied in)
first and open ones before resolved ones, which are folded away. Each shows its comments, a **Reply** box and
**Resolve when sent**. The Diff tab shows each thread under its line (folded once resolved), with **Reply**, which opens
that thread's box in the drawer. An outdated thread (its code has changed since) has no line in today's diff, so it's
only in the drawer.

In a terminal:

```sh
alden comment acme/shop#7 --threads                                  # the threads, with short ids
alden comment acme/shop#7 --reply q9aZ1Lw "Fixed in 3f2c."           # reply in a thread, by its id
alden comment acme/shop#7 --reply src/pay.ts:40 "Fixed." --resolve   # by its line, and resolve it
alden comment acme/shop#7 --resolve src/pay.ts:40                    # resolve it, saying nothing
```

A thread is named by the short id `--threads` shows, or by `file:line`: its line at the PR's head, or the line it was
started on when it's outdated. When several threads are on that line, an open one is picked before a resolved one, and
when that's still more than one, Alden asks for an id.

- **One reply per thread.** A second `--reply` in the same thread changes the text of the first, and `--resolve` alone
  ticks Resolve on it. Delete one with `--delete <id>`, like any comment.
- **Resolve with nothing to say** is a reply with no text: it resolves the thread and posts nothing in it.
- **A reply has no line of its own.** It's tied to its thread, not to the diff, so it doesn't move or go outdated when
  the PR moves, and it takes no suggestion.
- Alden checks the thread is on the PR, and that GitHub lets you reply there (and resolve it, when you tick Resolve:
  resolving takes write access to the repo, or being the PR's author) when you write the reply, and again when you
  send.
- From Claude Code, `alden_draft_comment` drafts a reply with `in_reply_to` (the thread's `file:line` or id). It can't
  resolve a thread: that's yours to tick.

The drawer, its summary before Send and `alden send` say where each reply goes: "Reply in thread on src/pay.ts:40",
"…, and resolve it", or "Resolve the thread on src/pay.ts:40". Replies are never part of the review's body.

### How a review with replies is sent

A review without replies or resolves is sent as it always was, in one request (see [Sending](#sending)). With them,
GitHub needs a few, and Alden makes them in an order where nothing half-posts:

1. The review is started as **pending**, with your line comments and body: `POST /repos/{owner}/{repo}/pulls/{n}/reviews`
   without a verdict. A pending review is visible only to you.
2. Each reply is added to that pending review (GraphQL `addPullRequestReviewThreadReply`).
3. The review is **submitted** with your verdict (`submitPullRequestReview`). Only now does anyone see any of it.
4. Each thread you ticked is resolved (`resolveReviewThread`), after the review is submitted and never before. A
   thread that's already resolved is left alone.

If step 2 or 3 fails, Alden deletes the pending review it started (and the replies in it), so nothing posts, and says
which step GitHub refused, e.g. "GitHub refused your reply in the thread on src/pay.ts:40". Your drafts stay. If it
can't delete the pending review either, it says so: discard it on the PR's page on GitHub before sending again.

If a resolve fails in step 4, the review has already posted and can't be taken back: Alden says which thread wasn't
resolved and why ("The review posted, but GitHub wouldn't resolve 1 thread"), and you can resolve it on GitHub.

A review of only replies works as a plain comment review. With nothing to post at all (a plain comment, no body, and
only resolves), there is no review: Alden just resolves the threads.

## When the PR moves

A comment is written against the PR's head commit. When the author pushes, Alden brings your comments along the next
time it lists them or sends them:

- A general note just moves to the new head. A linked note stays as it is: its link is to the code at the head you
  wrote it against.
- A comment on a line looks for its line again in the new diff of that file (or the file it was renamed to): the same
  text, on the same side, preferring a line whose neighbours still match, then the one nearest where it was. Found,
  the comment moves there.
- A comment on several lines (or a suggestion) moves only when every one of its lines is found again, unchanged, in
  the same order, together in one hunk. A suggestion is applied exactly as written, so it never moves onto code that
  differs, even by a space, from the code it was written against.
- Not found (the line changed, left the diff, or can't be told apart from others like it, such as a lone `}`), the
  comment is marked **outdated**. It keeps the line and commit it was written for, so you can see what it was about,
  and it can't be sent until you place it on a line again (in the UI) or delete it and write it again. A suggestion
placed again is against the code at its new place: check the replacement still fits.

Alden only compares lines it can see in the diff. It doesn't follow a line that moved out of the diff and back, or one
whose text changed, even trivially: those are outdated, on purpose. A comment Alden guessed the place of would post
somewhere you didn't choose.

## Sending

```sh
alden send acme/shop#7 --comment          # or --approve, or --request-changes
alden send acme/shop#7 --approve -m "Thanks, looks good."
```

Before anything posts, Alden shows the whole review: the body (your `-m` text, then the general notes, a linked note
with its link), each comment
with its file and line (or lines), each suggestion as old lines and new ones, each reply with its thread and whether it
resolves it, who drafted it, and the verdict. Before an approval it also lists the places Alden flagged in
its latest briefing of this PR that none of your comments is near (within three lines, on the same file). Then it asks.
`--yes` skips the question; without a terminal to ask on and without `--yes`, it refuses.

It sends one request, `POST /repos/{owner}/{repo}/pulls/{n}/reviews`, at the PR's current head commit, with exactly
what you wrote (with replies or resolves, a few: see
[How a review with replies is sent](#how-a-review-with-replies-is-sent)). Alden adds nothing to it but a suggestion's ` ```suggestion ` block and a linked note's link (and its
"Suggested change" block): no signature, no footer. A comment
on several lines goes as `start_line` and `start_side` to `line` and `side`.

Alden won't send, and says why, when:

- a comment is outdated (it names which),
- the PR got new commits since you last looked, which moved comments: look them over and send again,
- a comment's line isn't in the diff, or its range no longer fits in one hunk (it names which),
- the code a suggestion replaces isn't the code it was written against,
- there's nothing to say: a plain comment review needs a comment, a reply, a resolve or a body, and requesting changes
  needs a body or a general note,
- a reply's thread is gone, or GitHub won't let you reply there or resolve it (it names which).

On success, the PR's comments are deleted from Alden (they're on GitHub now) and Alden prints the review's link. If
GitHub refuses, nothing is deleted.

### Permissions

Sending needs no new sign-in. A classic token's `repo` scope, which Alden's own sign-in and the GitHub CLI's ask for,
already covers reviews. A fine-grained token needs **Pull requests: Read and write** on the repo. `alden doctor` says
whether your sign-in can post reviews when the token reports its scopes, and what it would need when it doesn't.

If GitHub says no (403), Alden says so with the fix for where your token comes from. A review you started on GitHub's
website and haven't submitted blocks a new one: submit or discard it there first.

## What Alden learns from it

The review you send teaches Alden more than a click on Useful would. Each place to look in the PR's latest briefing
that one of your comments is near counts toward that check's lesson: **2** when the review requests changes or a
comment there suggests a change, **1** for a plain comment. A comment on several lines is near anything within three
lines of any of them; a linked note counts the same at the code it links to, and one on a whole file is near anything
in it. A place you saw (in guided review or the diff) and approved past without a word counts a little the other way
(0.2), never for secrets, text aimed at AI reviewers or high and critical flags. A comment where Alden flagged nothing
is noted as something it missed, and the code areas you comment in rank higher in your queue. A comment near a finding
that came from one of your notes confirms the note instead, and teaches no check. Your own verdict on a place always
wins, and `learning.fromReviews = false` turns all of this off (and the Learn from my reviews switch in Settings).

After sending, `alden send` says what the review moved, e.g. "2 of 3 (2 from your review of acme/shop#412): one more
useful on untested-change flags and Alden will put them first among the places to look." See
[Reviews you send](memory.md#reviews-you-send).

## After you send

What the PR's author does with your comments is evidence too: a suggestion they apply, or a comment thread that gets
resolved, means the review landed. Alden notices both and learns from them, without you doing anything.

When a review is sent, Alden keeps, for each line comment, where it went: the review GitHub made, the file, its line
(or lines) and side at the head you sent it on, whether it was a suggestion (and the code it replaced), and the check
of the flagged place it was near, if any. Not the comment's text. These are kept 30 days in `~/.alden/alden.db`.

For PRs you sent a review on in the last 14 days, Alden then asks GitHub about the review threads you started, at most
once a day per PR: when the queue refreshes (in the background, after the queue is shown) and when you run
`alden feedback`. It counts:

- **Applied** (weight 2): a suggestion whose thread is resolved, or outdated by a push since, and whose code is now in
  the file at the PR's head near where you suggested it, with the code it replaced gone (a deletion: those lines gone).
  GitHub's API doesn't say a suggestion was applied, so Alden compares the file; leading and trailing spaces don't
  count, so a formatter's re-indent still matches.
- **Resolved** (weight 1): any other comment whose thread was resolved (by anyone), or went outdated because a push
  after your review changed its lines. A suggestion resolved without its code landing counts as resolved; if the code
  lands later, it counts as applied too.

Each is recorded once per comment, as a `review_signal` with `source: "outcome"` carrying the check, file and line of
the comment, and counts toward that check's lesson like the review's own signals (once per PR per topic, at its
strongest; see [What comes of them](memory.md#what-comes-of-them)). `alden feedback` shows them: "Outcomes: 3 suggestions applied, 2 comments resolved (last 14 days)".
Claude Code's `alden_feedback` adds the same line to its answer. A merged or closed PR is checked once more after it
closes, then never again.

**Cost:** one GraphQL request per PR per day at most (the PR's state, head, last 50 commits and first 100 review
threads), plus one more that day only when a resolved suggestion needs comparing with its file at the head (all such
files in one request, and never twice at the same head). PRs you reviewed more than 14 days ago cost nothing. A PR
that fails to answer is left until the next day. Nothing is written to GitHub.

To turn it off, set `fromReviews = false` under `[learning]` in `~/.alden/config.toml`
(`alden config set learning.fromReviews false`), or switch off **Learn from my reviews** in Settings. Alden then
neither keeps where your comments went nor asks GitHub about them.

## Where drafts are kept

In `~/.alden/alden.db`, on your machine, until you send or delete them. They're never in usage stats (which count
comments, never their text) or in `alden feedback --export`. See [Privacy and data](privacy.md).
