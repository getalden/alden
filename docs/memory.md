# Learning and memory

Alden learns what you look for, per repo, from what you already do: the flags you agree with or mark not needed, and
the PRs you open ahead of where it ranked them. It also keeps notes you write about what you care about. Everything it
uses is listed in `alden memory` (and the Memory view in `alden ui`), each item says what it changes, and any of it can
be forgotten.

Nothing here leaves your machine, except your notes: the model gets those with each review (see
[Privacy](#privacy)).

## What it learns

| From | Rule | What changes |
| --- | --- | --- |
| Your verdicts on a check's flags | 3 or more "agree", at least 3 to 1 | That check goes first among places to look, marked "↑ You usually agree with …". The model is told you care about it. |
| Your verdicts on a check's flags | 3 or more "not needed", at least 3 to 1 | That check's flags are left out of places to look, unless high severity. The briefing lists them as hidden, with the reason. |
| "Not needed" on one place in a PR | Once | A re-review of that PR leaves that place out, and says so. Other PRs are unaffected. |
| The PRs you open | Opened ahead of their rank 3 or more times, at least 60% of the time, in the last 90 days | PRs like that rank higher in your queue, with a reason such as "ranked higher: you usually open PRs touching db/migrations/ first". |

A few rules keep this honest:

- **Nothing is hidden silently.** Every place learning leaves out is listed under the places to look, with why.
- **Secrets are never quietened**, and no high-severity flag is ever left out.
- **Learning can't outrank a blocker.** A learned boost adds at most 3 points, less than an urgent label or stacked
  PRs. Failing CI still sinks a PR.
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

## Seeing and forgetting

```sh
alden memory                       # this clone's repo
alden memory --repo acme/shop --json
alden memory forget note:1a2b3c4d  # a note
alden memory forget check:tests.missing:down
```

Forgetting a learned item also forgets what it was learned from: only feedback after you forget it counts, so it comes
back only if your verdicts keep pointing that way.

To take back one dismissal on a PR, press "Not needed" again on that place in `alden ui` (it toggles off).

## Where it's kept

In `~/.alden/alden.db`, a SQLite database (WAL mode, so the CLI and the UI can write at once). Feedback, opens and
notes are stored as append-only events with unique ids, so a future sync can upload just what it hasn't sent. The same
file holds spending and when you first used Alden on each repo.

Alden needs Node 22.13 or later for the database (the standalone binary has it built in). The first run on an older
`~/.alden` imports the old JSON files (`feedback/`, `spend/`, `usage.json`) once and moves them to `~/.alden/legacy/`.

## Privacy

Learning happens on your machine and its data stays there. Your notes, and the checks you care about (as one line
each, e.g. "Cares about migration issues"), are sent to your model provider with each review; nothing else from
memory is. With `--no-llm`, nothing is. `alden feedback --export` shares feedback only, with names removed.
