---
"alden": minor
---

Briefings keep up with the base branch. For a PR, callers are now found in GitHub's merge of the PR onto its latest base (what CI tests), so a caller added or a file moved on main since the PR branched is found; what counts as changed is still the PR's own diff. When the PR conflicts, or GitHub hasn't made the merge yet, callers come from the PR's branch and the briefing says so. Each PR briefing records the commits it was made against, and `alden review` ends with "Callers from main at abc1234 + this PR". In the web UI and desktop app, the briefing says when it was made ("Briefed 30 min ago") and, once the PR or its base has moved on, what changed with **Re-brief** ("main has 4 new commits since"). Background briefings are served only while they still match the PR's head and base, and are prepared again when they don't.
