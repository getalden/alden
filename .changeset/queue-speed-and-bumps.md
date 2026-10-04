---
"alden": minor
---

The queue loads about three times faster: the search only fetches ids, and PR details, CODEOWNERS and stacked counts
load side by side (`ALDEN_DEBUG=queue` shows where the time goes). Major dependency bumps now rank higher, with a reason
like "major bump: nesbot/carbon 3 → 4". The web UI and desktop app show the last queue at once while a fresh one
loads, fetch the whole queue so the repo filter lists every repo, and each PR shows one waiting time: since you were
asked.
