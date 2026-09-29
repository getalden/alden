# The code graph

A diff shows what changed. It doesn't show who depends on it. For that, Alden builds a code graph of the repo and
lists the callers outside the diff of every public function, class and method the change touches. It then flags
removed or re-signed code that's still called, and gives the model those call sites as context.

## Languages

| Language | Status |
| --- | --- |
| TypeScript, TSX, JavaScript | Supported |
| Python | Supported |
| Go | Planned |
| PHP (Laravel, Symfony) | Planned |

Changed files in other languages are listed under "Not checked".

## How it works

1. **Parse.** Alden parses every tracked file with tree-sitter, compiled to WebAssembly, so nothing is compiled at
   install time on any OS. For each file it records definitions (functions, classes, methods, exported values),
   imports and references (calls, `new`, JSX elements, base classes, and functions passed as arguments).
2. **Cache.** Results are cached in `~/.alden/index`, keyed by each file's git blob hash, so later reviews only
   re-parse changed files. As a rough guide, a 3,000-file repo takes a few seconds the first time and under a second
   after that.
3. **Find what changed.** The diff's changed lines are mapped to the definitions that contain them, so a changed
   function body counts, not only a changed signature.
4. **Find callers.** Alden follows imports to the changed symbol:
   - TypeScript and JavaScript: relative imports (including `.js` imports of `.ts` files), `index` files, `tsconfig`
     path aliases, workspace packages, and re-exports through barrel files.
   - Python: module paths from the repo's source roots, relative imports, and names re-exported through `__init__.py`.

Indexing stops after 60 seconds. When that happens, the briefing says the results may be incomplete.

## How sure it is

- **Import match.** The call resolves to the changed symbol through the file's imports, or is in the same file.
- **Name match only.** A bare call with the same name (4 characters or more) and no import that resolves elsewhere.
  These are marked `name match only`.
- **Methods.** `obj.method()` counts in files that import the class. For very common names (`get`, `save`, `filter`,
  `update` and so on) only calls on `self`, `this`, `cls` or the class itself count, because `request.data.get()` is
  almost never your view's `get`.

Dynamic code (reflection, string-based dispatch, dependency injection) can't be traced statically. Treat "no callers"
as "none found", not "none exist".

## Reviewing PRs

Local reviews use your working tree. For a PR, Alden needs the PR's code on disk:

1. Run `alden review <pr>` from inside a clone of the PR's repo. Any remote may point at it, so a fork with an
   `upstream` remote works.
2. Alden fetches the PR into `refs/alden/pr-<number>` and checks it out in its own worktree under `~/.alden/worktrees`
   (one per repo, reused). Your branch, working tree and stash are never touched.

Outside a clone, the review still runs, and "Callers outside the diff" says why it was skipped. The first checkout of a
large repo can take a while; later ones reuse the worktree.

Skip the graph with `--no-graph`.
