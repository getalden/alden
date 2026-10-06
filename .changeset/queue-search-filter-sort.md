---
"alden": minor
---

Find a PR in a big queue quickly. In the web UI and the desktop app, `/` searches the queue (title, repo, `#number`, author, branch), a row of filters narrows it by repo, author (you, people, bots, AI agents), how you were asked (you or your teams), assignee, label, drafts, CI and age, and Sort puts it in rank, oldest-first, longest-waiting, last-updated or smallest-first order inside each lane. The count says "12 of 144", **Clear filters** goes back to everything, and filters and sort are remembered. `[` (or «) collapses the queue to a thin rail so the briefing takes the full width. `alden queue` gains `--author`, `--label`, `--search` and `--sort`, and each PR's facts now include its assignees.
