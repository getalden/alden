---
"alden": minor
---

Alden learns from what comes of your reviews. When a PR's author applies a suggestion you sent, or resolves a comment of yours (or a push makes it outdated), that's recorded once as an outcome, with the check of the flagged place it was near, and counts toward that check's lesson (2 for an applied suggestion, 1 for a resolved comment, once per PR per topic, on top of the review's own signals). Alden checks the PRs you reviewed in the last 14 days at most once a day each (one GitHub request per PR, in the background after a queue refresh, and on `alden feedback`), and `alden feedback` says "Outcomes: 3 suggestions applied, 2 comments resolved (last 14 days)". Set `learning.fromReviews = false` to turn it off.
