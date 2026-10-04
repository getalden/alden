---
"alden": patch
---

Escape sequences in PR titles, paths, branch names and bodies are removed whole, so a title like `\e[31mFix\e[0m`
shows as "Fix", not "[31mFix[0m". Links, window titles and clipboard writes go the same way; accents and emoji stay.
