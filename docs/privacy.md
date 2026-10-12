# Privacy and data

Alden runs on your machine. There is no Alden server, and nothing is sent to Alden's developers unless you opt in to
[anonymous usage stats](telemetry.md).

## What leaves your machine

| Goes to | What | When |
| --- | --- | --- |
| GitHub | API requests with your token: review requests, PR details, diffs, CI status, CODEOWNERS, and the review threads of PRs you reviewed (for [follow-ups](desktop.md#follow-ups-on-prs-you-reviewed), read only). Git fetches of PRs for the code graph. | `alden queue`, `alden review <pr>`, `alden stats`, `alden ui`, the desktop app, `alden mcp` |
| GitHub, only when you send | The review you send: its body, comments and verdict, exactly as shown before you confirmed. Alden posts only what you send. | The UI's Send button, `alden send` |
| PostHog (EU), only if you said yes | Anonymous usage stats: see [Usage stats](telemetry.md) | After each command; every minute while `alden ui` runs |
| Your model provider | The PR's title and description, the diff, a few lines around callers outside the diff, and your [notes](memory.md#your-notes) for the repo. | `alden review`, unless `--no-llm` |
| Your AI coding tool, through `alden mcp` | Queue rows, briefings including PR text and code, and your notes. From there they reach that tool's model provider. | When the tool calls Alden's tools |
| The npm registry | A request for Alden's newest version. Nothing about you or your repos. | `alden --version` and `alden doctor`, at most once a day; off with `updates.check false` or `ALDEN_NO_UPDATE_CHECK` |

Nothing goes to a model when no provider is configured or you pass `--no-llm`. With a local model (Ollama, LM Studio),
nothing leaves your machine at all.

**Likely secrets are hidden from the model.** Before the prompt is sent, Alden replaces anything that looks like a
credential with a placeholder that keeps only its kind and length, e.g. `[redacted GitHub token, ghp_…(44 chars)]`.
That covers the diff, the PR description and the caller snippets. It uses the same detection as the "Likely secrets"
check: known key formats, private keys (the whole key body), passwords in connection strings, and random-looking
values assigned to secret-like names. The briefing's footer says how many were hidden.

Detection is heuristic, so a secret in an unusual shape can still get through. Use `--no-llm` for changes you know
contain credentials, and rotate any secret that was committed: it's in the branch history even if the model never saw
it.

What happens to data at your model provider is governed by your agreement with them. Anthropic's API doesn't train on
API data by default.

## What stays on your machine

Feedback, the PRs you open and what Alden learns from them stay in `~/.alden/alden.db` ([Learning and
memory](memory.md)). So do the comments you're drafting, and the ones Alden drafted for you from its model's
findings, until you send or delete them; they're never in usage stats (which count keeps, edits and drops, never
text) or the feedback export ([Comments and sending a review](comments.md)). So do the [places you
saw](memory.md#places-you-saw) in guided review and the Diff tab: which of Alden's places (check, file and line) were
in front of you for 1.5 seconds, kept 90 days. They're never in usage stats or the feedback export either, and
**Learn from my reviews** off (`learning.fromReviews`) stops Alden noting them. So does where each line comment you sent
went (file, line, and a suggestion's code, never the comment's text, kept 30 days), to ask GitHub later whether it was
applied or resolved ([After you send](comments.md#after-you-send)). So do the [follow-ups](desktop.md#follow-ups-on-prs-you-reviewed)
on PRs you reviewed: each of your threads as last seen (resolved, outdated, its newest comment's id, never the text),
and one line per piece of news ("Ana replied to your comment on src/pay.ts:40"), kept 30 days, plus any PR's own
notification level. So does how long each review took, for [time to review](commands.md#time-to-review) (on unless you
turn off **Time my reviews**, `stats.reviewTime`): one record per review of a PR, from first opening its briefing to
sending the review, with the PR's name (to tell one review from the next), when you opened and sent it, active time
(in the UI, how long the PR's pane was visible and focused, leaving out stretches over 2 minutes without input; from a
terminal, the time from its briefing to the send, at most 30 minutes), how many flagged places you saw, how many
comments were drafted, kept and sent, whether Alden's model helped, and your verdict. Durations and counts only, never
what the PR or your comments say; kept 120 days, never synced or exported. With usage stats on, each review you send
adds one `review_timed` event with the times in coarse buckets and the counts, never the PR or repo. So do your notes, what you've spent on models, usage stats waiting to be sent (only if you said
yes), and this install's anonymous id and the salt for repo hashes. Checkouts of PRs for the code graph are in
`~/.alden/worktrees`. PR descriptions and last commit messages that the queue reads for [AI agents'
markers](queue.md#bots-and-ai-agents) are checked on your machine and dropped: only which agent was found (or that
none was) is kept, in `~/.alden/cache` by the PR's head commit for a week, and never sent anywhere. See [Files Alden keeps](configuration.md#files-alden-keeps). Your GitHub token is stored in the
OS keychain, or, where there's no keychain, in a file only your user can read. `alden auth logout` removes it. So is an
Anthropic or OpenAI API key you stored with `alden auth model`; `alden auth model --remove` removes them.

The desktop app's [background briefings](desktop.md#while-youre-away) make the same GitHub calls as a review while
you're away, and ask your model provider only if you turned on `background.model`. The briefings are held only in the
running server's memory, and are gone when you quit.

## Sharing your feedback

`alden feedback --export <file>` writes your feedback to a file you can share, for example with Alden's developers.
It replaces repo names with a hash salted with a value that never leaves your machine, and each flag's title with a
code salted fresh for each export, and drops paths, lines and notes. PR numbers, check ids, verdicts, times and the
model stay. What your sent reviews taught Alden ([review signals](memory.md#reviews-you-send)) is exported the same way:
which check, the kind of signal and its weight, without the file or line. `--full` keeps everything. Settings → Your
feedback in `alden ui` always exports redacted.

## Usage stats

Off unless you say yes. With your OK, Alden sends anonymous usage stats (which commands and views you use, review
counts and timings, roughly how long your reviews took, which way your feedback points) to PostHog in the EU. Never
code, titles, paths, repo or user names. See [Usage stats](telemetry.md) for every event and how to turn it off.

## This website

To help us improve it, getalden.dev counts page views, and clicks on its install, copy and Discord links. It sets no
cookies, stores nothing in your browser and loads no third-party script: a few lines in the site's own `site.js` send
each count straight to PostHog in the EU (`eu.i.posthog.com`), the same project as Alden's opt-in usage stats.

Each count carries the page's path (never its query string), the domain of the site that linked you (not the full
address), a rough screen width (phone, tablet, laptop or wide), and for a click, which link. Each page load gets a new
random id, so visits can't be tied together, and no person profile is made. Like any web request, it reaches PostHog
from your IP address; the project is set to discard IP addresses, and the site asks it not to look up a location.
Nothing is sent when your browser sends
Do Not Track or Global Privacy Control. The website is separate from Alden itself: the app sends nothing unless you
opt in.
