# Learning and memory

Alden learns what you look for, per repo, from what you already do: what you mark **Useful** or **Not useful** (on
places to look, the model's findings, checks and PR rows), the reviews you send, and the PRs you open ahead of where
it ranked them. It also keeps notes you write about what you care about. Everything it
uses is listed in `alden memory` (and the Memory view in `alden ui`), each item says what it changes, and any of it can
be forgotten.

Nothing here leaves your machine, except your notes: the model gets those with each review (see
[Privacy](#privacy)).

## What it learns

| From | Rule | What changes |
| --- | --- | --- |
| Useful on a check's flags, and comments in the reviews you send | 3 or more in weight, at least 3 to 1 | That check goes first among places to look, marked "↑ You usually mark … useful". The model is told you care about it. |
| Not useful on a check's flags, and flags you approved past without a word | 3 or more in weight, at least 3 to 1, with at least one Not useful | That check is quietened: its flags are left out of places to look, unless high or critical severity, and listed as hidden with the reason. Its row in the checks says "quietened by your feedback" (terminal, `alden ui`, `alden_review`), and the model is told to raise those concerns only when they're serious. |
| A review you send | Once per place per PR | Comments near a place count toward its check's lesson (2 for requested changes or a suggestion, 1 for a comment); approving past a place you saw counts 0.2 against it; comments in a code area count like opening a PR there first. See [Reviews you send](#reviews-you-send). |
| Useful on a model finding from one of your notes, or a comment you send near one | Once per review | The note is confirmed ("confirmed 3×" in Memory). No check lesson. See [Findings from your notes](#findings-from-your-notes). |
| Not useful on a model finding from one of your notes | | Recorded, and changes nothing unless you stop applying the note there or edit it. No check lesson. |
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
toward your useful rate but teach no lesson. A finding from one of your notes teaches the note instead (below), whatever
its topic.

## Reviews you send

When you send a review from Alden ([Comments and sending a review](comments.md)), it looks at each place to look in
the PR's latest briefing and records what your review said about it, as a **review signal** in the feedback log. Each
counts toward the place's check lesson by its weight, in the units of a click on Useful:

| Signal | When | Weight |
| --- | --- | --- |
| `request_changes` | The review requests changes, and a comment of yours is near the place | 2 toward Useful |
| `suggestion` | A comment near the place suggests a change | 2 toward Useful |
| `comment` | A comment near the place | 1 toward Useful |
| `silent_pass` | Alden knows you saw the place (guided review or the diff), and you **approved** without a comment near it | 0.2 toward Not useful |
| `miss` | A comment on code where no place to look was near | none: counted with what Alden missed |

"Near" is the same as for the warning before you send: on the same file, within three lines of the place (anything in
the file for a place without a line). A comment on several lines is near anything within three lines of any of them,
and a linked note counts at the code it links to (one on a whole file is near anything in it). Where comments near
one place differ, the strongest counts. Comments by Claude Code count the same once you send them: you sent them.

The rules that keep it honest:

- **One review can't teach a lesson.** A PR counts once per topic, at its strongest signal: two suggestions on one PR's
  untested code count 2, not 4. Three PRs with two suggestions and a comment between them (2 + 2 + 1 = 5) are enough.
- **Silence is weak, and never enough.** A silent pass is only recorded when Alden knows you saw the place and you
  approved: a review that only comments, or requests changes elsewhere, hasn't passed it. It counts 0.2, and a
  check is only ever quietened with at least one Not useful you clicked yourself. Never for likely secrets, text aimed
  at AI reviewers, or high and critical flags, and never for places from briefings made before Alden 0.7 (their
  severity wasn't kept). A comment on a topic in a PR outweighs approving past another of its flags there.
- **Your own verdict wins.** If you marked a place useful, not useful or dismissed it, the review changes nothing there.
- **Once per place per PR.** A second review of the same PR adds a signal for a place only when it says more (a
  suggestion after a comment); approving past a place after commenting on it adds nothing, and a miss isn't counted
  twice.
- **Only sent comments count.** Drafts you delete, or never send, teach nothing; general notes have no place, so they
  teach nothing either.
- **Findings from your notes teach the note.** A comment near one confirms the note instead of giving a signal, and
  approving past one says nothing (see [Findings from your notes](#findings-from-your-notes)).
- **Code areas you comment in** (the first two folders of the path, as in the queue) count like opening a PR there
  ahead of its rank, once per review per area, toward "PRs like that" ranking higher: "ranked higher: you often
  comment on PRs touching app/api in your reviews". Lockfiles don't count.
- **Outcomes count too.** When a PR's author applies a suggestion of yours or resolves your comment, that's recorded as
  its own signal (`applied`, `resolved`, from `source: "outcome"`), once per PR per topic, on top of the review's.

Turn it off with `alden config set learning.fromReviews false` (your user config only): nothing from your reviews is
recorded after that, Useful and Not useful still count, and what was already learned stays until you forget it.

Reviews sent with Alden 0.4 to 0.6 recorded a comment near a place as a Useful verdict marked `via: "comment"`. Those
still count, as from your reviews.

## Places you saw

A review teaches Alden by what's in it, and also by what isn't: a place you looked at and then approved without a word
on it counts as a weak "probably not worth your time". A place you never looked at teaches nothing, so `alden ui` and
the desktop app note which places you actually saw:

- **In guided review**, a step that's been in front of you for 1.5 seconds. Stepping past it sooner doesn't count.
- **In the Diff tab**, an **E1**, **E2**… marker that's been on screen for 1.5 seconds. Scrolling past it doesn't count,
  and nor does a marker in a hidden tab or a collapsed file.

Each place is noted once per PR and head commit (its check, file and line, and whether you saw it in guided review or
the diff), for 90 days and the last 200 PRs. Never for **My changes**, and never from the terminal: `alden review`
can't tell what you read.

Turn it off with **Learn from my reviews** in Settings, or `alden config set learning.fromReviews false`. Alden then
notes nothing and learns from your reviews no more; Useful and Not useful still teach it.

Learned items in the Memory view say where they came from, newest first: "from your review of acme/shop#412, Oct 8",
"from how it went with acme/shop#409, Oct 6" (an outcome), "from your reactions, Oct 1", "from the PRs you opened, Sep
28", then "and 3 more". `alden memory` and `alden_memory` name the reviews and outcomes a lesson came from. After you
send a review, the Comments drawer (and `alden send`) says in one line what Alden learned from it, if anything ("Alden
learned: 2 of 3 (2 from your review of acme/shop#412): one more useful on untested-change flags and Alden will put
them first among the places to look").

## Seeing it build

Every useful or not useful says what it did to learning, in `alden ui` (next to the button), in `alden_feedback`'s
answer, and on a queue row:

- "2 of 3: one more not useful on API change flags (public signature and caller flags count together) and Alden will
  quieten them."
- "3 of 3 not useful on untested-change flags: Alden quietens them in this repo."
- "Dependabot PRs: 2 not useful so far. One more and Alden will rank them lower."

Sending a review says what it moved, after "Sent:" in `alden send` (and in the answer the UI gets), counting weights
and saying where they came from:

- "2 of 3 (2 from your review of acme/shop#412): one more useful on untested-change flags and Alden will put them
  first among the places to look."
- "1.4 of 3 (0.4 from your reviews): 2 more not useful on untested-change flags and Alden will quieten them."

`alden feedback` lists where each lesson stands in every repo you've given feedback in, and counts what your reviews
said apart from your clicks ("From 4 reviews you sent: 1 suggestion, 3 comments near flags; 2 flags you saw and
approved past; 1 comment where Alden flagged nothing"), so the useful rate stays what you clicked.

## Your notes

```sh
alden memory add "Money is in cents, never floats"
alden memory add --repo acme/shop "Server actions must check the session first"
```

Notes are per repo (by default the clone you're in) and go to the model with every review of that repo, under "What
the reviewer cares about", marked as coming from you rather than the PR's author. At most 12 notes are sent, each cut
to 300 characters. The briefing says how many the model was given.

## Findings from your notes

Each note goes to the model with a short id for that review ("[N1] Money is in cents, never floats"), and the model can
say a finding is there because of one. Alden keeps that only when the id is one it gave a note in that prompt, so text
in the PR can't claim to be your note. The finding then says "Because of your note: …" in the briefing, guided
review, the terminal and `alden_review`. (A Markdown export to share leaves your notes out, as it leaves out the rest of
your memory.)

Reacting to it teaches the note, not a check:

- **Useful** confirms the note, once per review. Memory shows "confirmed 3×".
- **A comment you send near it** confirms the note too, once per place per PR, and never over a verdict you gave it
  yourself. It gives no review signal, and so moves no check lesson (see [Reviews you send](#reviews-you-send)).
- **Not useful** is recorded and changes nothing by itself. `alden ui` then offers **Stop applying this note to
  app/api?** (the finding's first two folders, or the file for one at the repo root) and **Edit the note**.

A note you've stopped under a folder or file isn't given to the model for a change whose files are all there. For a
change that's partly there, the model is told where the note doesn't apply ("[N2] Every file needs a code owner header
(doesn't apply under vendor)"), and a finding from that note pointing only at those files is left out and listed as
hidden. From a terminal:

```sh
alden memory exclude note:1a2b3c4d app/api    # stop applying it under app/api
alden memory include note:1a2b3c4d app/api    # apply it there again
```

`alden memory` lists where each note is stopped, and the Memory view has **Apply under app/api again**.

## Seeing, changing and forgetting

The Memory view in `alden ui` lists each repo, then "What you look for" and "What you skip" in it. Each item says where
it came from (for a learned item, its `sources`: your clicks, the PRs you opened, and each review by PR, e.g. "from
your review of acme/shop#412 (2)") and what it changes; notes can be edited, anything can be forgotten (and the forget undone), and learning
can be paused. The same from a terminal:

```sh
alden memory                       # this clone's repo
alden memory --repo acme/shop --json
alden memory edit note:1a2b3c4d "Money is in cents, never floats"
alden memory exclude note:1a2b3c4d vendor  # the note doesn't apply under vendor/
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
notes (with where you stopped each one) are stored as append-only events with unique ids, so a future sync can upload just what it hasn't sent. The same
file holds spending, when you first used Alden on each repo, and the comments you're drafting (until you send or delete
them), and the [places you saw](#places-you-saw) in the last 90 days.

Alden needs Node 22.13 or later for the database (the standalone binary has it built in). The first run on an older
`~/.alden` imports the old JSON files (`feedback/`, `spend/`, `usage.json`) once and moves them to `~/.alden/legacy/`.

## Privacy

Learning happens on your machine and its data stays there. Usage stats, if you opted in, count review signals by kind
only, never which check, file or line. Your notes (with where a note doesn't apply, when the change touches it), and
the checks you care about or quietened (as
one line each, e.g. "Cares about migration issues", "Usually finds untested-change concerns not useful: raise them
only when they're serious"), are sent to your model provider with each review; nothing else from memory is. With `--no-llm`, nothing is. The places you saw never leave your machine: not to the model, not in usage stats, not in the feedback export. `alden feedback --export` shares feedback only: repo names become a salted
hash, and titles, paths and notes are removed. See [Sharing your feedback](privacy.md#sharing-your-feedback).
