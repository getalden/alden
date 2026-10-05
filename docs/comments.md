# Comments and sending a review

Once Alden has briefed you on a PR, you can say what you think without leaving it: write comments on the places to
look or on any line of the diff, collect them as a pending review, and send them to GitHub as **one review** that
comments, approves or requests changes.

Alden posts only what you send. Nothing goes to GitHub until you press Send in the UI or confirm `alden send` in a
terminal: never in the background, never from a model, never from Claude Code.

## Writing comments

In [the web UI](web-ui.md) and the desktop app, write a comment on a place to look or on a line of the diff. In a
terminal:

```sh
alden comment acme/shop#7 src/pay.ts:12 "Is fee in cents here?"
alden comment acme/shop#7 "Nice cleanup overall."          # a general note
alden comment acme/shop#7                                   # list what's waiting
alden comment acme/shop#7 --delete a1b2c3d4
```

`<pr>` is a PR URL, `owner/repo#123`, or a number from your last `alden queue` (Alden says which PR a number picked).
`file:line` is a line in the new file; add `--left` for a removed line, numbered in the old file.

- **A comment on a line** becomes an inline comment on that line. GitHub only takes comments on lines in the PR's diff
  (changed lines and the few shown around them), so Alden checks the line when you write the comment and says if it
  isn't one.
- **A comment without a line** is a general note. Notes go into the review's body, after anything you write for the
  body itself, oldest first.

From Claude Code, ask Claude to draft a comment and it uses Alden's `alden_draft_comment` tool. Its drafts sit with
yours, marked "drafted by Claude Code", and post as you only when you send them. There is no tool for sending. See
[Alden in your AI coding tool](mcp.md).

## When the PR moves

A comment is written against the PR's head commit. When the author pushes, Alden brings your comments along the next
time it lists them or sends them:

- A general note just moves to the new head.
- A comment on a line looks for its line again in the new diff of that file (or the file it was renamed to): the same
  text, on the same side, preferring a line whose neighbours still match, then the one nearest where it was. Found,
  the comment moves there.
- Not found (the line changed, left the diff, or can't be told apart from others like it, such as a lone `}`), the
  comment is marked **outdated**. It keeps the line and commit it was written for, so you can see what it was about,
  and it can't be sent until you place it on a line again (in the UI) or delete it and write it again.

Alden only compares lines it can see in the diff. It doesn't follow a line that moved out of the diff and back, or one
whose text changed, even trivially: those are outdated, on purpose. A comment Alden guessed the place of would post
somewhere you didn't choose.

## Sending

```sh
alden send acme/shop#7 --comment          # or --approve, or --request-changes
alden send acme/shop#7 --approve -m "Thanks, looks good."
```

Before anything posts, Alden shows the whole review: the body (your `-m` text, then the general notes), each comment
with its file and line, who drafted it, and the verdict. Before an approval it also lists the places Alden flagged in
its latest briefing of this PR that none of your comments is near (within three lines, on the same file). Then it asks.
`--yes` skips the question; without a terminal to ask on and without `--yes`, it refuses.

It sends one request, `POST /repos/{owner}/{repo}/pulls/{n}/reviews`, at the PR's current head commit, with exactly
what you wrote. Alden adds nothing to it: no signature, no footer.

Alden won't send, and says why, when:

- a comment is outdated (it names which),
- the PR got new commits since you last looked, which moved comments: look them over and send again,
- a comment's line isn't in the diff (it names which),
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

A comment you sent near a place Alden flagged is the clearest sign that the place was worth your eyes, so it counts as
"useful" for that check, once per place per PR. It never overrides a verdict you gave that place yourself. See
[Learning and memory](memory.md#comments-you-send).

## Where drafts are kept

In `~/.alden/alden.db`, on your machine, until you send or delete them. They're never in usage stats (which count
comments, never their text) or in `alden feedback --export`. See [Privacy and data](privacy.md).
