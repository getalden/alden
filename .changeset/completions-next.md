---
"alden": minor
---

`alden completion zsh|bash|fish` prints a tab-completion script for every command and flag (`alden completion --help`
says how to install it). In a terminal, `alden queue`, `alden review` and `alden doctor` end with a dim "Next:" line
suggesting the obvious next command; never with `--json` or in a pipe. `alden queue`'s "Open one with `alden open
<#>`" line moves into it, so piped output no longer ends with a hint.
