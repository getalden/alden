---
"alden": minor
---

A Diff tab beside each briefing in the web UI and the desktop app (`d` switches): the PR's code itself, or your uncommitted changes, file by file with old and new line numbers, so you no longer switch to GitHub to read it. Alden's places to look are marked E1, E2… at their lines (`]` and `[` go from one to the next) and your comments show as badges; a place's file:line in the briefing opens the diff there, with GitHub's link kept beside it. Renames, binary files and diffs too large for GitHub to send say so, large diffs stay quick (rows render as you scroll, big files start collapsed), and a PR's diff is kept per push so reopening it is instant. Behind it, `GET /api/diff` in the local API.
