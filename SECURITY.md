# Security

Please report security problems privately, not in a public issue: email **security@getalden.dev** with what you
found, how to reproduce it, and what it affects. You'll hear back within three working days.

Alden runs on your machine with your GitHub sign-in and your model account, so we treat these as security bugs:

- anything that lets another website, process or user reach `alden ui`'s API or read its session key;
- leaks of your GitHub token or model key (to logs, files, prompts, the network);
- PR content (titles, descriptions, diffs, file names) that can run code, write files outside `~/.alden`, control the
  terminal, or get Alden to act beyond producing a briefing;
- secrets in a diff reaching the model despite redaction.

[docs/security.md](docs/security.md) describes how Alden handles each of these today.
