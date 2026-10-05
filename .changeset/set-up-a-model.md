---
"alden": minor
---

Set up a model in about a minute. `alden setup` offers three choices: paste an Anthropic API key (Alden checks it with one tiny request, which costs a fraction of a cent, says why one doesn't work, and stores it in the keychain), use a local model through Ollama (it recommends a coder model for your machine's memory, downloads it with progress if needed, and writes the config), or checks only. In the web UI and the desktop app, "No model set up" becomes **Set up a model**, with the same choices and no restart afterwards. `alden doctor` suggests `alden setup` when there's no model, and the first run mentions it once.
