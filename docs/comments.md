# Comments and sending a review

Once Alden has briefed you on a PR, you can say what you think without leaving it: write comments on the places to
look or on any line (or lines) of the diff, suggest changes the author can apply with a click, collect them as a
pending review, and send them to GitHub as **one review** that
comments, approves or requests changes.

Alden posts only what you send. Nothing goes to GitHub until you press Send in the UI or confirm `alden send` in a
terminal: never in the background, never from a model, never from Claude Code.

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

- **A comment on a line** becomes an inline comment on that line. GitHub only takes comments on lines in the PR's diff
  (changed lines and the few shown around them), so Alden checks the line when you write the comment and says if it
  isn't one.
- **A comment on several lines** covers a range, as GitHub's own multi-line comments do. GitHub only takes a range on
  one side of the diff and within one hunk (one `@@` block), so Alden checks that too and says which line is outside
  the diff, or that the range spans two hunks. In the UI, give the line as `4–9`.
- **A suggested change** on a comment ("Suggest a change" in the UI, on the new side only) posts after the comment's
  text as a `suggestion` block, which the author can accept on GitHub. The UI starts it from the line's text when it
  has it; left empty, it suggests deleting the line(s). A comment with a suggestion needs no other text.
- **A comment without a line** is a general note. Notes go into the review's body, after anything you write for the
  body itself, oldest first.

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
- Suggestions apply to the new file, so they go on the new side only: not with `--left`, and not as a general note.

What posts is your text, a blank line, then the suggestion in a ` ```suggestion ` block. If the code itself contains a
run of three or more backticks (a Markdown snippet in a doc comment, say), Alden fences it with one more backtick than
the longest run, so nothing in your code can end the block early.

`alden comment <pr>` and `alden send` show a suggestion as the lines it replaces (`-`) and the lines it suggests (`+`).
Alden keeps the replaced lines' text from when you wrote the suggestion, so it can tell whether the code under it has
changed (below).

From Claude Code, ask Claude to draft a comment or suggest a change and it uses Alden's `alden_draft_comment` tool. Its drafts sit with
yours, marked "drafted by Claude Code", and post as you only when you send them. There is no tool for sending. See
[Alden in your AI coding tool](mcp.md).

## When the PR moves

A comment is written against the PR's head commit. When the author pushes, Alden brings your comments along the next
time it lists them or sends them:

- A general note just moves to the new head.
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

Before anything posts, Alden shows the whole review: the body (your `-m` text, then the general notes), each comment
with its file and line (or lines), each suggestion as old lines and new ones, who drafted it, and the verdict. Before an approval it also lists the places Alden flagged in
its latest briefing of this PR that none of your comments is near (within three lines, on the same file). Then it asks.
`--yes` skips the question; without a terminal to ask on and without `--yes`, it refuses.

It sends one request, `POST /repos/{owner}/{repo}/pulls/{n}/reviews`, at the PR's current head commit, with exactly
what you wrote. Alden adds nothing to it but a suggestion's ` ```suggestion ` block: no signature, no footer. A comment
on several lines goes as `start_line` and `start_side` to `line` and `side`.

Alden won't send, and says why, when:

- a comment is outdated (it names which),
- the PR got new commits since you last looked, which moved comments: look them over and send again,
- a comment's line isn't in the diff, or its range no longer fits in one hunk (it names which),
- the code a suggestion replaces isn't the code it was written against,
- there's nothing to say: a plain comment review needs a comment or a body, and requesting changes needs a body or a
  general note.

On success, the PR's comments are deleted from Alden (they're on GitHub now) and Alden prints the review's link. If
GitHub refuses, nothing is deleted.

### Permissions

Sending needs no new sign-in. A classic token's `repo` scope, which Alden's own sign-in and the GitHub CLI's ask for,
already covers reviews. A fine-grained token needs **Pull requests: Read and write** on the repo. `alden doctor` says
whether your sign-in can post reviews when the token reports its scopes, and what it would need when it doesn't.

If GitHub says no (403), Alden says so with the fix for where your token comes from. A review you started on GitHub's
website and haven't submitted blocks a new one: submit or discard it there first.

## What Alden learns from it

A comment (or a suggestion) you sent near a place Alden flagged is the clearest sign that the place was worth your eyes, so it counts as
"useful" for that check, once per place per PR. A comment on several lines is near anything within three lines of
any of them. It never overrides a verdict you gave that place yourself. See
[Learning and memory](memory.md#comments-you-send).

## Where drafts are kept

In `~/.alden/alden.db`, on your machine, until you send or delete them. They're never in usage stats (which count
comments, never their text) or in `alden feedback --export`. See [Privacy and data](privacy.md).
