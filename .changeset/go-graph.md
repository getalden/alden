---
"alden": minor
---

The code graph follows more of how Go code calls itself. A changed method is reached through the repo's interfaces its type implements (marked `name match only`, with the interface named: "through interface GitConfigClient") and through structs embedding its type ("through Server (embeds Base)"). Functions and methods named without a call count as uses: struct fields (`FetchOptions: shared.FetchOptions`), assignments, returns and option lists. Package-level function variables (`var now = func() …`) are definitions their callers reach. Changed unexported functions, methods and types now list their callers in the rest of their package, since a Go package is often dozens of files sharing helpers. Very common method names (`List`, `Patch`, `Status`…) aren't followed through interfaces, and sure matches come before name-only ones in "Callers outside the diff". The index format changed, so the first review after updating re-parses the repo.
