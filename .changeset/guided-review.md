---
"alden": minor
---

Guided review. In the web UI and the desktop app, **Start guided review** (or `g`) takes a briefing's places one at a time: why each is there, the code at it from the PR's diff, and **Look at these too**, the files worth opening beside it. Each step keeps Useful, Not useful and Dismiss, `n` and `p` move between steps, `Esc` leaves and you can resume where you were, and the model's other findings follow as extra steps. The related files come from the code graph the briefing already built, at no extra cost: other callers of the changed code, tests that call it or import its file, and files importing it. They show under each place in `alden review`, in `alden review --markdown` and in what `alden_review` gives your AI coding tool, and in the briefing's JSON as `related` on each place.
