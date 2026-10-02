# Usage stats (telemetry)

Alden can send anonymous usage stats to its developers, **only if you say yes**. They tell us which parts of Alden
people use, whether reviews get faster, and where it falls short, so we can improve it and show what it does for
teams.

## Saying yes or no

Alden asks once: the first time you run a command in a terminal, or with a card at the top of the queue in
`alden ui`. The default is no. Change your mind any time:

```sh
alden telemetry          # on, off, or not asked yet
alden telemetry on
alden telemetry off      # also deletes anything not yet sent
alden telemetry show     # what's waiting to be sent, exactly as it would be sent
```

Or in `alden ui`: Settings → Usage stats. The answer lives in your user config (`telemetry.enabled` in
`~/.alden/config.toml`). A repo's `.alden.toml` can't turn it on.

It's always off when `DO_NOT_TRACK` is set, when `ALDEN_TELEMETRY=0`, and in CI. Alden never asks outside an
interactive terminal, so scripts and pipes are unaffected.

## What's sent

Every event and property is listed in [`packages/schema/src/telemetry.ts`](../packages/schema/src/telemetry.ts)
(published as `telemetry-event.v1.json`). Events are checked against it before they're queued; anything else is
dropped.

| Event | What it says |
| --- | --- |
| `command_run` | Which command (queue, review, ui, …), whether it worked, how long it took |
| `queue_ranked` | How many PRs need you, are fast-track or dismissed, across how many repos, how many your feedback moved |
| `review_completed` | PR or local; files and lines; languages; callers found; checks flagged; places shown; how many your feedback hid; notes used; model, its status and cost; how long it took |
| `feedback_given` | Useful, not useful or dismiss; on a place, finding or check; which of Alden's checks |
| `missed_reported` | That you reported a miss, and whether you said where (not what) |
| `reaction_given`, `pr_opened`, `memory_changed` | The reaction; the opened PR's rank; add, edit, forget, pause… |
| `stats_viewed` | Median time to first review and cycle time, before and after Alden, and how many PRs |
| `telemetry_enabled` | That you said yes |

Each also carries Alden's version, where it ran (terminal, UI or desktop app), Node or the standalone binary, the OS
and CPU type, and how many days since this install first ran.

**Never sent:** code, diffs, PR titles or descriptions, file paths, repo names, user names, your notes, model output,
tokens or keys. A repo appears only as a hash salted with a random value that never leaves your machine, so we can
count repos but can't work out which ones they are.

## Where it goes

To [PostHog](https://posthog.com) in the EU (`eu.i.posthog.com`), in batches: after each command, and every minute
while `alden ui` runs. Each install has a random id (not derived from you or your machine), and events are sent
without a person profile. Events wait in `~/.alden/alden.db` while you're offline, up to 5,000; turning stats off
deletes them.
