---
"alden": minor
---

Learning you can see, about the PRs that matter now. The queue learns code areas ("you open PRs touching app/api
first") and who wrote a PR: you, people, bots or AI agents (Copilot, Claude, Devin, Cursor, Codex and more), and which
one ("you usually skip Dependabot PRs"). Every useful or not useful says how close it brought a lesson ("2 of 3: one
more not useful on API change flags and Alden will quieten them"), in `alden ui`, `alden_feedback` and `alden feedback`.
Quietened checks say so in the checks list, the model is told to stop raising them, and model findings tagged with a
topic teach the same lessons as the checks. Changed signatures and callers outside the diff now count as one API change
lesson, and learning text says useful and not useful throughout.
