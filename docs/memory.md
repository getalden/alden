# Learning and memory

Alden learns what you look for, per repo, from what you already do: what you mark **Useful** or **Not useful** (on
places to look, the model's findings, checks and PR rows), and the PRs you open ahead of where it ranked them. It also keeps notes you write about what you care about. Everything it
uses is listed in `alden memory` (and the Memory view in `alden ui`), each item says what it changes, and any of it can
be forgotten.

Nothing here leaves your machine, except your notes: the model gets those with each review (see
[Privacy](#privacy)).

## What it learns

| From | Rule | What changes |
| --- | --- | --- |
| Useful on a check's flags | 3 or more, at least 3 to 1 | That check goes first among places to look, marked "↑ You usually agree with …". The model is told you care about it. |
| Not useful on a check's flags | 3 or more, at least 3 to 1 | That check's flags are left out of places to look, unless high severity. The briefing lists them as hidden, with the reason. |
| Dismiss on one place in a PR | Once | A re-review of that PR leaves that place out, and says so. Other PRs are unaffected, and nothing is learned from it. |
| PRs you open, or mark Useful in the queue | 3 or more, at least 60% of the time, in the last 90 days | PRs like that rank higher, with a reason such as "ranked higher: you usually open PRs touching db/migrations/ first". |
| PRs you mark Not useful in the queue | 3 or more, at least 3 to 1 | PRs like that rank lower: "ranked lower: you marked 4 PRs labelled docs not useful". |
| Dismiss on a PR in the queue | Once | The PR leaves the queue until it changes (a new push or comment), listed under "dismissed · show". |

A few rules keep this honest:

- **Nothing is hidden silently.** Every place learning leaves out is listed under the places to look, with why.
- **Secrets are never quietened**, and no high-severity flag is ever left out.
- **Learning can't outrank a blocker.** A learned boost adds at most 3 points, less than an urgent label or stacked
  PRs. Failing CI still sinks a PR.
- **Dismiss isn't a lesson.** It hides one place on one PR (or one PR in the queue) and teaches nothing.
- **It doesn't feed on itself.** An open counts as "ahead of its rank" against the queue as it would have been ranked
  without learning, and only among PRs you haven't opened in the last 12 hours. Working down the list in order teaches
  nothing.
- **The checks still run.** Learning changes what's picked and how the queue is ordered, never what a check found.

What counts as "PRs like that": the sensitive directories a PR touches (from `queue.sensitivePaths`), dependency
changes, its author (not bots), and its labels.

## Your notes

```sh
alden memory add "Money is in cents, never floats"
alden memory add --repo acme/shop "Server actions must check the session first"
```

Notes are per repo (by default the clone you're in) and go to the model with every review of that repo, under "What
the reviewer cares about", marked as coming from you rather than the PR's author. At most 12 notes are sent, each cut
to 300 characters. The briefing says how many the model was given.

## Seeing, changing and forgetting

The Memory view in `alden ui` lists each repo, then "What you look for" and "What you skip" in it. Each item says where
it came from and what it changes; notes can be edited, anything can be forgotten (and the forget undone), and learning
can be paused. The same from a terminal:

```sh
alden memory                       # this clone's repo
alden memory --repo acme/shop --json
alden memory edit note:1a2b3c4d "Money is in cents, never floats"
alden memory forget check:tests.missing:down
alden memory restore check:tests.missing:down
alden memory forget --all
alden memory pause                 # keep what was learned, stop applying it
alden memory resume
```

Forgetting a learned item also forgets what it was learned from: only feedback after you forget it counts, so it comes
back only if your reactions keep pointing that way. Restoring takes the forget back. While learning is paused, your
reactions are still saved and notes still go to the model; dismissals still apply, since you asked for them directly.

To take back a reaction, press the same button again in `alden ui` (it toggles off).

## Where it's kept

In `~/.alden/alden.db`, a SQLite database (WAL mode, so the CLI and the UI can write at once). Feedback, opens and
notes are stored as append-only events with unique ids, so a future sync can upload just what it hasn't sent. The same
file holds spending and when you first used Alden on each repo.

Alden needs Node 22.13 or later for the database (the standalone binary has it built in). The first run on an older
`~/.alden` imports the old JSON files (`feedback/`, `spend/`, `usage.json`) once and moves them to `~/.alden/legacy/`.

## Privacy

Learning happens on your machine and its data stays there. Your notes, and the checks you care about (as one line
each, e.g. "Cares about migration issues"), are sent to your model provider with each review; nothing else from
memory is. With `--no-llm`, nothing is. `alden feedback --export` shares feedback only: repo names become a salted
hash, and titles, paths and notes are removed. See [Sharing your feedback](privacy.md#sharing-your-feedback).
