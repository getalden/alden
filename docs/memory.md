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
| Useful on a check's flags | 3 or more, at least 3 to 1 | That check goes first among places to look, marked "↑ You usually mark … useful". The model is told you care about it. |
| Not useful on a check's flags | 3 or more, at least 3 to 1 | That check is quietened: its flags are left out of places to look, unless high or critical severity, and listed as hidden with the reason. Its row in the checks says "quietened by your feedback" (terminal, `alden ui`, `alden_review`), and the model is told to raise those concerns only when they're serious. |
| A comment you send near a place to look | Once per place per PR | Counts as Useful on that place's check, toward the lesson above. See [Comments you send](#comments-you-send). |
| Dismiss on one place in a PR | Once | A re-review of that PR leaves that place out, and says so. Other PRs are unaffected, and nothing is learned from it. |
| PRs you open, or mark Useful in the queue | 3 or more, at least 60% of the time, in the last 90 days | PRs like that rank higher, with a reason such as "ranked higher: you usually open PRs touching db/migrations/ first". |
| PRs you mark Not useful in the queue | 3 or more, at least 3 to 1 | PRs like that rank lower: "ranked lower: you usually skip Dependabot PRs (4 marked not useful)". |
| Dismiss on a PR in the queue | Once | The PR leaves the queue until it changes (a new push or comment), listed under "dismissed · show". |

A few rules keep this honest:

- **Nothing is hidden silently.** Every place learning leaves out is listed under the places to look, with why.
- **Secrets and text aimed at AI reviewers are never quietened**, and no high or critical flag is ever left out.
- **Learning can't outrank a blocker.** A learned boost adds at most 3 points, less than an urgent label or stacked
  PRs. Failing CI still sinks a PR.
- **Dismiss isn't a lesson.** It hides one place on one PR (or one PR in the queue) and teaches nothing.
- **It doesn't feed on itself.** An open counts as "ahead of its rank" against the queue as it would have been ranked
  without learning, and only among PRs you haven't opened in the last 12 hours. Working down the list in order teaches
  nothing.
- **One-offs don't teach.** Each PR counts once per feature, however often you open it. Opening a PR ahead of others
  counts for a feature only when a PR you passed over didn't have it, so a feature every PR shares (all from people,
  all in `src/lib`) never jumps. Model findings on one topic count once per briefing.
- **Overlapping lessons don't add up.** "Bot PRs" and "Dependabot PRs" are both about who wrote it, so a Dependabot PR
  moves by one step, not two. Who wrote it, what it touches and its labels each count once.
- **The checks still run.** Learning changes what's picked and how the queue is ordered, never what a check found.

What counts as "PRs like that":

- **Code areas**: the first two folders of each changed path (`app/api`, `py/pricing`; `py` for `py/x.py`; the repo
  root for a root-level file), up to the three with the most changed lines. Lockfiles don't count.
- The **sensitive directories** it touches (from `queue.sensitivePaths`) and **dependency changes**.
- **Who wrote it**: you, people, bots or AI agents ("you usually skip bot PRs"), and which bot or agent ("you usually
  open Copilot PRs first"), or which person. See [Bots and AI agents](queue.md#bots-and-ai-agents) for how they're told
  apart.
- Its **labels**.

PRs opened before code areas and authors were learned keep what they were recorded with, so lessons learned before
still hold; the new features count from then on.

## Lessons by topic

A check's lesson is about a topic, and two checks share one: **changed public signatures and callers outside the
diff are one "API change" lesson** (`check:api:up` or `check:api:down`), since they're two views of the same change
and your reactions are split across both rows. Every other check is its own topic (`check:tests.missing:down`). A
forget made by a check's own id before topics existed (`check:signatures.changed:down`) still holds.

Alden's model tags each finding with a topic (tests, api, migrations, config, dependencies, or other). Useful or not
useful on a tagged finding counts toward that topic's lesson, once per briefing however many findings share it, and a
finding on a quietened topic takes no place to look unless it's high severity. Untagged ("other") findings count
toward your useful rate but teach no lesson.

## Comments you send

When you send a review ([Comments and sending a review](comments.md)), each place to look in the PR's latest briefing
that one of your line comments is near (on the same file, within three lines of it, or anywhere in the file for a
place without a line) counts as **Useful** on that place: you didn't only agree it was worth a look, you had something
to say about it. It's recorded as an ordinary verdict, marked `via: "comment"` in the feedback log, so it counts toward
the check's lesson like a click on Useful and shows in `alden feedback`.

- **Once per place per PR.** A second review of the same PR, or another comment near the same place, adds nothing.
- **Your own verdict wins.** If you already marked that place useful, not useful or dismissed, the comment changes
  nothing. Clearing a verdict and then commenting doesn't count it again either.
- **Only sent comments count.** Drafts you delete, or never send, teach nothing. General notes have no place, so they
  teach nothing either.
- Comments by Claude Code count the same once you send them: you sent them.

## Seeing it build

Every useful or not useful says what it did to learning, in `alden ui` (next to the button), in `alden_feedback`'s
answer, and on a queue row:

- "2 of 3: one more not useful on API change flags (public signature and caller flags count together) and Alden will
  quieten them."
- "3 of 3 not useful on untested-change flags: Alden quietens them in this repo."
- "Dependabot PRs: 2 not useful so far. One more and Alden will rank them lower."

`alden feedback` lists where each lesson stands in every repo you've given feedback in.

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
file holds spending, when you first used Alden on each repo, and the comments you're drafting (until you send or delete
them).

Alden needs Node 22.13 or later for the database (the standalone binary has it built in). The first run on an older
`~/.alden` imports the old JSON files (`feedback/`, `spend/`, `usage.json`) once and moves them to `~/.alden/legacy/`.

## Privacy

Learning happens on your machine and its data stays there. Your notes, and the checks you care about or quietened (as
one line each, e.g. "Cares about migration issues", "Usually finds untested-change concerns not useful: raise them
only when they're serious"), are sent to your model provider with each review; nothing else from memory is. With `--no-llm`, nothing is. `alden feedback --export` shares feedback only: repo names become a salted
hash, and titles, paths and notes are removed. See [Sharing your feedback](privacy.md#sharing-your-feedback).
