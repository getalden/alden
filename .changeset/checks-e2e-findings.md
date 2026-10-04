---
"alden": minor
---

Sharper checks: a `critical` severity for likely secrets and migrations that can lose data; a new "Text aimed at AI
reviewers" check; moved and deleted files flag the files still importing their old path, and show where they moved
from; comment-only changes and pure moves no longer count as untested code; package.json `resolutions` and
`overrides` count as dependency changes; callers in code take places before callers in tests; and Python callers
through `from .services import product_sync` are found.
