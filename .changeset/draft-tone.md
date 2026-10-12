---
"alden": minor
---

Pick how Alden writes the comments it drafts: terse (one line, no reasoning), concise (the default), detailed (why, the impact and a fix) or teaching (for newer teammates). It's a style for Alden's drafts, not an imitation of you. Set the default with `alden config set drafts.tone detailed`, give a repo its own on this machine (`PUT /api/tone`, the UI's Tune), or pick one for one call with `alden comment <pr> --draft --tone terse`. The briefing's drafts, Draft my review and Draft with Alden all use it; every tone keeps the same rules (the PR's text treated as data, never an approval, never sent untouched). See [The tone of drafts](https://getalden.dev/docs/models#the-tone-of-drafts).
