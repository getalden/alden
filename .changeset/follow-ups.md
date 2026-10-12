---
"alden": minor
---

After you review a PR, the desktop app tells you what happened next: replies to your comments, threads resolved, a push that makes one of your comments outdated, and a second review request. One notification per PR ("2 replies, 1 resolved", "Ana asked you to review again"), each piece of news once, with the system's sound unless `notifications.sound` is off. Choose how much in Settings → Notifications or `notifications.followUps`: Off, Re-review only, When it's your turn (the default: a re-review, or every comment you left resolved or answered, once per round) or Every reply. Any PR can have its own level until it's merged or closed: the bell beside its name, or `alden watch <pr> --every-reply` (`--default` to go back; `alden watch` lists them). Alden follows the open PRs you reviewed in the last 14 days, finds them with one read-only GitHub request each refresh, and reads a PR's threads again only when it changed.
