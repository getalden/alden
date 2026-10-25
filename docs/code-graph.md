# The code graph

A diff shows what changed. It doesn't show who depends on it. For that, Alden builds a code graph of the repo and
lists the callers outside the diff of every public function, class and method the change touches (in Go, package-internal
ones too; see [Go](#go)). It then flags
removed or re-signed code that's still called, and gives the model those call sites as context.

## Languages

| Language | Status |
| --- | --- |
| TypeScript, TSX, JavaScript | Supported |
| Python | Supported |
| Go | Supported |
| PHP, with Laravel and Symfony patterns | Supported |
| Ruby, with Rails patterns | Supported |
| Swift | Supported |
| Java and Kotlin | Supported |

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
     its `package` clause declares. Files in one package see each other's names without imports. Methods are also
     reached through interfaces and embedded structs; see [Go](#go).
   - PHP: `use` imports (plain, aliased and grouped) and fully qualified names, mapped to files through the PSR-4
     prefixes in every `composer.json` (`autoload` and `autoload-dev`), or failing that the one file whose path ends
     in the class's namespace path. Classes in the same namespace see each other without `use`. Type hints count as
     uses, since frameworks mostly use a class by injecting it.
   - Ruby and Swift: no imports to follow (Rails autoloads, and a Swift module sees all its files), so every file sees
     every class. Methods are matched by the class they're called on; see [Ruby, Swift, Java and Kotlin](#ruby-swift-java-and-kotlin).
   - Java and Kotlin: `package` clauses and imports (single, wildcard `.*` and Kotlin's `as` aliases), across both
     languages, so Kotlin calling a Java class (or the other way round) is found. Classes in the same package see each
     other without imports.

5. **Moved and deleted files.** A file the change moves or deletes is treated like a removed symbol: files that still
   import it by its old path (and that the PR didn't change) are listed under "Callers outside the diff" as
   `imports src/pricing.ts (moved to src/lib/pricing.ts)`. An import that still resolves after the move (`./pricing`
   now finding `pricing/index.ts`) isn't counted. In Go, an import breaks only when no package is left in the old
   directory. A move with no edits isn't untested code, and the briefing says where each moved file came from.

Indexing stops after 60 seconds. When that happens, the briefing says the results may be incomplete. As a guide,
Kubernetes (13,500 Go files outside `vendor/`) indexes in about 18 seconds the first time and 1.5 seconds after that,
and symfony/symfony (12,000 PHP files) in about 12 seconds and 1 second. Swift parses more slowly than the others:
Alamofire (100 files) takes about a second the first time.
`vendor/`, `node_modules/` and build output are skipped.

## Related files

Each place in "Needs your eyes" also suggests files to look at beside it ("Look at these too" in the terminal, the
web UI's guided review and `alden_review`), worked out from the graph the briefing already built, so they cost no
extra parsing:

- **caller**: code calling the changed symbols at that place (the definition around its line, or all of the file's
  changed ones), outside the diff. For a place that is itself a caller, the symbol's other callers. Up to 4, sure
  matches before name-only ones.
- **test**: tests calling those symbols or importing the changed file (test files by name, as the checks tell them
  apart). Up to 2; a test's call comes before its import line.
- **importer**: files importing the changed file (in Go, its package). For a file still importing a moved or deleted
  one, the other files importing the old path. Up to 2.

One entry per file, never the place's own. Without the graph (no clone, `--no-graph`, a language it doesn't read) a
place has none, and model findings never have any.

## Signatures

For Go, PHP, Ruby, Swift, Java and Kotlin, "Changed public signatures" uses the graph: it compares each function's and method's whole
declaration before and after the change, keyed by type, so multi-line parameter lists compare properly and two types'
`Close` methods don't get mixed up. A Go interface's signature is its method set; a struct's is its name, since adding
fields breaks nobody using keyed literals. Moving a declaration to another file in the same Go package isn't reported.
TypeScript and Python use a heuristic that reads declarations from the diff's changed lines.

A change that only appends parameters existing calls don't need to pass (a default value, an optional `b?: T`, a
rest parameter, Python's `*args` or keyword-only defaults, Go's variadic `...T`, Ruby keyword arguments with defaults
or a `&block`) counts as compatible: it's listed,
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
imports the package, is counted too. In Go, a bare name in another package is always that package's own, so Go's
name-only matches are only the uncertain cases below: calls through interfaces, and methods named without a call.

## Ruby, Swift, Java and Kotlin

With no type inference, a method call is matched by what it's called on:

- **Sure matches.** Calls on the class itself (`Rule.find`, `Store.shared`), on a variable named like it (`rule.apply`,
  `ruleRunner.run`), on what a class-level getter returns (`Rule.find(1).apply`), and bare or `self` calls inside the
  class or its subclasses.
- **Declared types.** A receiver declared with a type is that type, whatever it's named: fields, parameters and
  locals (`val transport: Transport`, `Client client`, `weak var client: StatsigClientType?`), and values built by a
  constructor (`val call = DnsCall()`, `var x = new Foo()`, `let request = DataRequest(…)`, Ruby's
  `client = Api::Client.new`). A call on one of the class's own types (itself, a subclass, an implementation) is sure;
  on a parent or interface it's a name match; on any other type it isn't listed, even when the name matches.
- **More receivers.** A parameter, field or local typed as a parent or interface reaches every implementation, as a
  name match. Kotlin's `x::method` is a call on `x`, and bare calls in `Foo(…).apply { }`, `x.run { }` and
  `with(x) { }` are on that receiver. Swift's `$state` is the property wrapper `@Protected var state` declares, in any
  file. A call on what a function in the same file returns (`loadServiceMethod(m).invoke()`) is on its declared
  return type.
- **Swift leading-dot calls.** `.chunked(size)` names a static member or enum case of a type only the context knows, so
  it's a name match for any `chunked` that isn't too common a name.
- **Name matches.** Other calls with the same method name, in files that use the class (Java and Kotlin: import it or
  share its package; Ruby and Swift: mention it) or reach it through a parent class. Very common names (`call`, `save`,
  `update`, `count`, `toString`…) count only as sure matches.
- **Constructors.** A changed `initialize` (Ruby), `init` (Swift), Java constructor or Kotlin `constructor` is called by
  every `Foo.new`, `Foo(...)` or `new Foo(...)`.
- **Visibility.** Private methods (Ruby's `private` sections, `private def` and `private :name`; `private` and
  `fileprivate` in Swift; `private` in Java; `private` and `protected` in Kotlin) aren't followed outside their file,
  except a Ruby module's: those are for the classes including it. A method the change makes private is still
  followed, since its callers outside now break.
- **Nested classes and imported members (Java, Kotlin).** `MockResponse.Builder`'s methods are reached from files
  importing `MockResponse`. A member imported by name (Kotlin's `import okhttp3.internal.Locks.withLock`, Java's
  `import static …Util.closeQuietly`) is reached wherever that file calls it.
- **Swift extensions and Kotlin extension functions** belong to the type they extend; Kotlin `companion object` members
  belong to the class. A top-level Kotlin extension on a type from outside the repo (`fun NavGraphBuilder.topicScreen()`)
  is reached where it's imported, and from its own package, called bare on an implicit receiver.

### Rails

- **Jobs.** `perform_later` and `perform_now` call `perform`.
- **Callbacks and macros.** Method names given as symbols in a class body count as calls: `before_action :set_rule`,
  `validate :check_dates`, `after_commit :sync, if: :changed?`. Association names (`has_many :entries`) don't.
- **Dynamic calls.** `send(:name)`, `public_send(:name)` and `try(:name)` call `name`.
- **Concerns.** `include`, `extend` and `prepend` count as parents, so a concern's methods are reached through the
  models that include it. Methods in `included do` and `class_methods do` blocks belong to the concern.
- **Scopes.** `scope :active, -> {…}` defines `active`.
- **Namespaces.** Classes are told apart by their full name, so a change to `RedbarkAccount::Processor` doesn't list
  every `PlaidAccount::Processor.new` in the app. A bare `Processor` is looked up as Ruby does: in the modules around
  it, innermost first, then at the top level. `ActivityPub::FetchRepliesService.new.call` is a call on that service.
- **RSpec.** In `RSpec.describe Rule::Runner do`, `described_class` and `subject` stand for `Rule::Runner`.
  `let(:service) { instance_double(VerifyQuoteService) }` (or `Foo.new`, or `allow(Foo).to receive(:new).and_return(x)`)
  types the variable, and `expect(service).to have_received(:call)` and `allow(…).to receive(:call)` count as calls.
- **Policies and serializers.** In `StatusPolicy`, Pundit's `record` is a `Status`; in `REST::StatusSerializer`,
  `object` is.

`method_missing`, `define_method` and string-built calls aren't traced. Swift's protocol witnesses and Kotlin's and
Java's interface calls are followed by method name, or by the receiver's declared type when it has one.

## Go

Go code calls a lot through types the call site doesn't name. The graph follows:

- **Package-internal code.** A changed unexported function, method, type or function variable is looked up too: a Go
  package is often dozens of files sharing helpers, so `isStaleSeries` changing in `head.go` reaches its callers in
  `head_wal.go`. Only its own package can call it. Helpers in `_test.go` files aren't followed.
- **Interfaces.** A changed method is reached through the repo's interfaces its type implements, judged by method
  names (an interface's own and those of interfaces it embeds; Alden doesn't compare parameter types, and methods of
  interfaces from outside the repo, such as `io.Reader`, aren't required). Calls in files that use the interface's
  package count, marked `name match only` and with the interface named: `calls Client.PushDefault (signature changed)
  through interface GitConfigClient, name match only`. This is how dependency injection reaches an implementation:
  `team.Service` in one package, `teamimpl.Service` in another. Names that dozens of unrelated types implement (Go's
  common list above, and `List`, `Patch`, `Watch`, `Status` and the like, which every generated API client has) aren't
  followed through interfaces.
- **Embedded structs.** A method promoted through embedding (`type Server struct{ *store.Base }`) is reached by calls
  in files that use the embedding type's package, up to three levels deep, unless that type declares its own method of
  the same name. These are sure matches: `calls Base.Sync (changed) through Server (embeds Base)`.
- **Functions as values.** A function or method named without being called is a use: struct fields
  (`FetchOptions: shared.FetchOptions`), assignments (`opts.Run = runEdit`, `h := s.handle`), returns, option lists
  (`[]Option{WithRetry}`) and package-level values. `pkg.Func` and bare names are sure; `x.Method` is a name match
  unless `x` is the method's receiver, since it may as well read a field of another type.
- **Function variables.** A package-level `var now = func() time.Time {…}`, often swapped out in tests, is a
  definition its callers reach, exported or not.

Struct fields aren't followed: `x.Name` reads are everywhere, and a type check would be needed to tell whose field it
is.

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

1. Alden finds a clone of the PR's repo: the one you run `alden review <pr>` in, or else one it saw you run Alden in
   before, or one under the folders in `clones.folders` (see [Configuration](configuration.md#clones)). Any remote may
   point at the PR's repo, so a fork with an `upstream` remote works.
2. Alden fetches GitHub's merge of the PR onto its base (`refs/pull/<number>/merge`, what CI tests) into
   `refs/alden/pr-<number>-merge`, and the PR's head into `refs/alden/pr-<number>`, and checks the merge out in its own
   worktree under `~/.alden/worktrees` (one per repo, reused). Your branch, working tree and stash are never touched.

With no clone, the review still runs, and "Callers outside the diff" says why it was skipped. The first checkout of a
large repo can take a while; later ones reuse the worktree.

Skip the graph with `--no-graph`.

### Keeping up with the base

Others keep merging while a PR waits. A PR's branch holds the rest of the repo as it was when the PR branched, so a
caller added on main since, or a file moved there, wouldn't be in it. That's why callers are found in GitHub's merge:
the PR on top of the latest base.

- **What changed is still the PR's own diff**: the PR against where it branched, as GitHub shows it. In the merge, the
  PR's changed files are put back to the PR's version, so the diff's line numbers match them even where main has
  edited the same file since. (A caller main added inside one of those files is the one thing this misses.)
- **No merge.** When the PR conflicts with its base, or GitHub hasn't made the merge for its latest push yet, callers
  come from the PR's branch, and "Callers outside the diff" says so: "Callers from the PR's branch: it conflicts with
  main, so changes merged since aren't included."
- **No fetch when nothing moved.** Alden asks GitHub for the PR's head and merge commits along with the PR, and skips
  the fetch when it already has both.
- **What it was briefed against.** Each PR briefing records the head commit it saw (`headSha`), the base commit its
  graph saw (`baseSha`, the merge's first parent), where callers came from (`graphFrom`: `merge` or `head`) and when
  it was made. `alden review` ends with "Callers from main at abc1234 + this PR".
- **Stale briefings.** Comparing those with the PR now takes one GitHub request: a new push makes a briefing stale,
  and so do new commits on the base for a graph from the merge. The [web UI](web-ui.md#when-it-was-briefed-and-re-brief) says "main has 4 new
  commits since · Re-brief", and the [desktop app](desktop.md#while-youre-away) prepares a fresh briefing instead of
  showing a stale one.

The index cache is keyed by each file's content (its blob hash), so the merge and the PR's branch share it safely,
and only files that differ between them are parsed again.
