---
"alden": minor
---

**First run**: with no GitHub sign-in yet, the web UI and the desktop app open on three short steps, one screen each: sign in with GitHub (saying it asks for the `repo` and `read:org` scopes), choose how Alden thinks (your API key, Anthropic or OpenAI, a local model through Ollama, or checks only), then how many PRs are waiting on you and the top four, with **Open the queue**. **Skip setup** leaves at any step and Settings → **Run setup again** brings them back. `alden` on its own in a terminal, signed out, now walks the same steps in text (sign in, `alden setup`, the queue) instead of stopping at "Not signed in".
