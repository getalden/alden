---
"alden": patch
---

Desktop and web UI fixes: clicking Alden in the Dock brings the window back; choosing a repo folder says where callers
now come from and shows that repo's PRs (with Show all repos); "I've signed in" says what failed (the keychain refused,
GitHub rejected the token, or no sign-in anywhere) instead of doing nothing; the Settings toggles fill their box; and
`release:dry-run --desktop` unregisters and deletes the unsigned Alden.app it built, which could open instead of the
installed app.
