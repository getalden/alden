# The code graph

A diff shows what changed. It doesn't show who depends on it. For that, Alden builds a code graph of the repo and
lists the callers outside the diff of every public function, class and method the change touches. It then flags
removed or re-signed code that's still called, and gives the model those call sites as context.

## Languages

| Language | Status |
| --- | --- |
| TypeScript, TSX, JavaScript | Supported |
| Python | Supported |
| Go | Supported |
| PHP, with Laravel and Symfony patterns | Supported |

Changed files in other languages are listed under "Not checked". Blade templates aren't parsed, but are searched
for fully qualified calls (see [Laravel and Symfony](#laravel-and-symfony)).

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
     A submodule imported from its package (`from .services import product_sync`, `from . import product_sync`) counts
     as the module, so `product_sync.upsert()` reaches `services/product_sync.py`.
   - Go: import paths under the repo's modules, read from every `go.mod` (nested modules, and local `replace`
     directives such as Kubernetes' `staging/` packages). An import reaches every file in the package, under the name
     its `package` clause declares. Files in one package see each other's names without imports.
   - PHP: `use` imports (plain, aliased and grouped) and fully qualified names, mapped to files through the PSR-4
     prefixes in every `composer.json` (`autoload` and `autoload-dev`), or failing that the one file whose path ends
     in the class's namespace path. Classes in the same namespace see each other without `use`. Type hints count as
     uses, since frameworks mostly use a class by injecting it.

Indexing stops after 60 seconds. When that happens, the briefing says the results may be incomplete. As a guide,
Kubernetes (13,500 Go files outside `vendor/`) indexes in about 18 seconds the first time and 1.5 seconds after that,
and symfony/symfony (12,000 PHP files) in about 12 seconds and 1 second.
`vendor/`, `node_modules/` and build output are skipped.

## Signatures

For Go and PHP, "Changed public signatures" uses the graph: it compares each function's and method's whole
declaration before and after the change, keyed by type, so multi-line parameter lists compare properly and two types'
`Close` methods don't get mixed up. A Go interface's signature is its method set; a struct's is its name, since adding
fields breaks nobody using keyed literals. Moving a declaration to another file in the same Go package isn't reported.
TypeScript and Python use a heuristic that reads declarations from the diff's changed lines.

A change that only appends parameters existing calls don't need to pass (a default value, an optional `b?: T`, a
rest parameter, Python's `*args` or keyword-only defaults, Go's variadic `...T`) counts as compatible: it's listed,
but callers are flagged as reached by a behaviour change rather than broken.

## How sure it is

- **Import match.** The call resolves to the changed symbol through the file's imports, or is in the same file.
- **Name match only.** A bare call with the same name (4 characters or more) and no import that resolves elsewhere.
  These are marked `name match only`.
- **Methods.** `obj.method()` counts in files that import the class (in Go, the type's package). For very common
  names (`get`, `save`, `filter`, `update` and so on) only calls on `self`, `this`, `cls` or the class itself count,
  because `request.data.get()` is almost never your view's `get`. Go has its own list (`String`, `Error`, `Close`,
  `Get`, `Save`, logging methods…), where the method's receiver (`s` in `func (s *Server)`) plays the part of `this`.

Alden doesn't infer types, so a method call on a variable of another type with the same method name, in a file that
imports the package, is counted too. In Go, a bare name in another package is always that package's own, so Go has no
name-only matches.

## Laravel and Symfony

PHP frameworks call a lot of code without naming it. The graph follows the patterns it can see:

- **Interfaces and parents.** A method is also reached through the interfaces and parent classes its class extends,
  which is how container bindings and injected dependencies call it (`$this->gateway->charge()` with a
  `PaymentGateway` type hint), and through subclasses and classes that use it as a trait.
- **Facades.** An app's own facade reaches its target: `getFacadeAccessor()` returning `Foo::class`, or a container key
  with the target named in the class's `@see` docblock, as Laravel's own facades do.
- **Eloquent.** `scopePublished` is called as `published()`. On a model, relationships and accessors are read as
  properties (`$post->author`, `getFullTitleAttribute` as `$post->full_title`). Property reads are marked
  `name match only`, since another model may have a property of the same name.
- **Constructors.** A changed `__construct` is called by every `new`.
- **Common names.** `save`, `find`, `where`, `handle`, `toArray` and others count only on `$this`, `self`, `static`,
  `parent` or the class itself.
- **Blade templates.** Fully qualified static calls such as `{{ \Illuminate\Mail\Markdown::parse($slot) }}`.
- **Service configuration.** When a class's constructor changes, or the class is removed, the YAML and XML config that
  names it (Symfony's `services.yaml`, for example).

Container bindings by string key, `app('name')`, event listeners registered by name and routes to controller actions
aren't traced.

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
