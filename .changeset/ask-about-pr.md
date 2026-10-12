---
"alden": minor
---

Ask your model a question about a PR: `alden ask <pr> "Does anything still read the old column?"`, or `POST /api/ask` in the UI. It answers from the PR's latest briefing of its current push, the diff around the places that matter and your notes, streaming the answer as it's written, in one call within your caps (recorded in `alden spend` as `owner/repo#12 question`). The PR's text goes to the model fenced as data, a PR with text aimed at AI reviewers isn't sent, and answers aren't stored: the last five on a PR stay in the running app for follow-ups. See [Ask about this PR](https://getalden.dev/docs/models#ask-about-this-pr).
