---
"alden": minor
---

`alden auth model` stores your Anthropic API key in the keychain (asked for without showing it, or read from standard
input), so the desktop app, `alden ui` and `alden mcp` find it too; `--remove` takes it out, and Settings has a
write-only field for it. `alden auth status` and `alden doctor` say where the key comes from, never the key. The order
is ANTHROPIC_API_KEY (and the other Anthropic variables), then the stored key, then an `ant auth login` profile.
