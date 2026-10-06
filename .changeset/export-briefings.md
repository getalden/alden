---
"alden": minor
---

Export a briefing instead of screenshotting it. `alden review <pr> --markdown` prints it as a Markdown document to share or save (`> briefing.md`): the PR and its link, what it does, where to look with file and line, every check with its evidence, callers, what wasn't checked, and the model and its cost. In the web UI and the desktop app, **Export** (or `e`) in the briefing's toolbar copies the same Markdown, saves it as `owner-repo-123-briefing.md` (the desktop app saves to your Downloads folder and says where), or prints it, with a print layout that drops the queue and buttons so it saves cleanly as a PDF. Your memory notes stay out, and secrets stay masked. In the desktop app, "Briefing ready" now plays the system's notification sound; turn it off in Settings → Notifications or with `alden config set notifications.sound false`.
