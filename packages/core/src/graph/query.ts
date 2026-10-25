import type { Definition, FileSymbols, TypedVariable } from "./extract.js";
import { dirOf, type Resolver } from "./resolve.js";

/** A place that calls (or instantiates, or renders) a symbol. */
export interface CallSite {
  path: string;
  line: number;
  /**
   * "import": the call resolves to the symbol through the file's imports (or is in the defining file).
   * "name": only the name matches and no import could be resolved, so it may be a different symbol.
   */
  confidence: "import" | "name";
  /**
   * Go: how the call reaches a method other than through its own type: "interface Fetcher" (a call through an
   * interface the type implements) or "Outer (embeds Inner)" (a method promoted from an embedded struct).
   */
  via?: string;
}

export interface SymbolRef {
  path: string;
  name: string;
  /** For methods, the class they belong to. */
  container?: string;
}

interface Binding {
  /** How the name appears in the importing file: a bare name, or an object for namespace imports. */
  local: string;
  namespace: boolean;
  /** The file and exported name it refers to ("*" for a whole module). */
  target: string;
  imported: string;
  reexport: boolean;
  /** The import's line in the importing file. */
  line: number;
  /** Java and Kotlin: a member imported by name (`import okhttp3.internal.Locks.withLock`); `imported` is its class. */
  member?: boolean;
}

/**
 * Method names too common to match on name alone: `x.get()` in a file that imports a view class is almost never that
 * view's get. For these, only `self.`/`this.`/`cls.`/`Class.` calls count.
 */
const COMMON_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "save",
  "update",
  "create",
  "filter",
  "all",
  "first",
  "set",
  "add",
  "remove",
  "clear",
  "has",
  "items",
  "keys",
  "values",
  "append",
  "extend",
  "push",
  "pop",
  "map",
  "forEach",
  "find",
  "then",
  "catch",
  "run",
  "call",
  "apply",
  "bind",
  "send",
  "close",
  "open",
  "read",
  "write",
  "start",
  "stop",
  "init",
  "load",
  "parse",
  "format",
  "render",
  "validate",
  "clean",
  "to_dict",
  "toString",
  "toJSON",
]);

/**
 * Go's equivalents: method names that interfaces make universal (String, Error, Close…) or that every type has. For
 * these, only calls on the method's own receiver inside the type's methods, or on the type itself, count.
 */
const GO_COMMON_METHODS = new Set([
  "String",
  "Error",
  "Close",
  "Get",
  "Set",
  "Add",
  "Delete",
  "Update",
  "Create",
  "Read",
  "Write",
  "Run",
  "Start",
  "Stop",
  "Init",
  "Load",
  "Save",
  "Reset",
  "Len",
  "Less",
  "Swap",
  "Next",
  "Done",
  "Wait",
  "Lock",
  "Unlock",
  "Err",
  "Name",
  "Type",
  "Value",
  "Key",
  "Keys",
  "Values",
  "Do",
  "Exec",
  "Query",
  "Open",
  "Flush",
  "Copy",
  "Clone",
  "Equal",
  "Hash",
  "ID",
  "Parse",
  "Format",
  "Validate",
  "Apply",
  "ServeHTTP",
  "MarshalJSON",
  "UnmarshalJSON",
  "MarshalText",
  "UnmarshalText",
  "Context",
  // Logging: every logger has these, so h.Log.Debug() is almost never your Debug.
  "Debug",
  "Info",
  "Warn",
  "Log",
  "Print",
  "Printf",
  "Println",
  "Errorf",
  "Fatal",
  "Fatalf",
]);

/**
 * Go method names that dozens of unrelated types implement (generated API clients, gRPC streams, workers). A call
 * through an interface with one of these could reach any of them, so interfaces aren't followed for them.
 */
const GO_INTERFACE_COMMON = new Set([
  "List",
  "Patch",
  "Watch",
  "Push",
  "Pull",
  "Send",
  "Recv",
  "Process",
  "Execute",
  "Call",
  "Build",
  "Check",
  "Describe",
  "Description",
  "Title",
  "Kind",
  "Status",
  "Version",
  "Config",
  "Ping",
]);

/** Laravel and PHP names too common to trust on any receiver: only `$this`, `self`, `static` or the class count. */
const PHP_COMMON_METHODS = new Set([
  "get",
  "set",
  "has",
  "all",
  "first",
  "find",
  "findOrFail",
  "where",
  "with",
  "load",
  "save",
  "create",
  "update",
  "delete",
  "fill",
  "make",
  "query",
  "count",
  "exists",
  "pluck",
  "map",
  "filter",
  "each",
  "push",
  "put",
  "forget",
  "toArray",
  "toJson",
  "jsonSerialize",
  "handle",
  "boot",
  "register",
  "render",
  "refresh",
  "send",
  "dispatch",
  "validate",
  "authorize",
  "rules",
  "run",
  "execute",
  "process",
  "__invoke",
  "__toString",
]);

/** Ruby and Rails names every model, job or service has: only calls on the class, `self` or a like-named receiver count. */
const RUBY_COMMON_METHODS = new Set([
  "new",
  "call",
  "perform",
  "save",
  "save!",
  "update",
  "update!",
  "create",
  "create!",
  "destroy",
  "destroy!",
  "delete",
  "find",
  "find_by",
  "where",
  "each",
  "map",
  "select",
  "reject",
  "first",
  "last",
  "count",
  "size",
  "sum",
  "include?",
  "empty?",
  "present?",
  "blank?",
  "valid?",
  "to_s",
  "to_h",
  "to_a",
  "to_json",
  "as_json",
  "inspect",
  "name",
  "value",
  "key",
  "fetch",
  "merge",
  "run",
  "process",
  "execute",
  "render",
  "reload",
  "touch",
  "errors",
  "attributes",
]);

/** Swift's equivalents: collection, Combine and lifecycle names. */
const SWIFT_COMMON_METHODS = new Set([
  "init",
  "append",
  "insert",
  "remove",
  "removeAll",
  "map",
  "compactMap",
  "flatMap",
  "filter",
  "reduce",
  "forEach",
  "contains",
  "first",
  "sorted",
  "description",
  "hash",
  "encode",
  "decode",
  "load",
  "save",
  "update",
  "reload",
  "start",
  "stop",
  "run",
  "cancel",
  "resume",
  "send",
  "sink",
  "store",
  "get",
  "set",
  "callAsFunction",
]);

/** Java and Kotlin: collection, stream, builder and scope-function names. */
const JVM_COMMON_METHODS = new Set([
  "get",
  "set",
  "add",
  "remove",
  "put",
  "size",
  "isEmpty",
  "contains",
  "equals",
  "hashCode",
  "toString",
  "close",
  "run",
  "call",
  "apply",
  "accept",
  "test",
  "build",
  "builder",
  "of",
  "valueOf",
  "getName",
  "getId",
  "getValue",
  "setValue",
  "iterator",
  "stream",
  "map",
  "filter",
  "forEach",
  "collect",
  "start",
  "stop",
  "init",
  "execute",
  "invoke",
  "length",
  "append",
  "clear",
  "copy",
  "compareTo",
  "next",
  "hasNext",
  "let",
  "also",
  "with",
  "takeIf",
  "orElse",
  "subscribe",
  "onCreate",
  "onDestroy",
]);

/** Receivers that mean "this object or class" in any language. */
const SELF_NAMES = new Set(["self", "this", "cls", "$this", "static", "parent"]);

/** Ruby apps (autoloaded constants) and Swift modules: every file sees every type without importing it. */
const moduleWide = (path: string) => /\.(rb|rake|swift)$/.test(path);

/** Java and Kotlin share packages and imports, and call each other. */
const isJvm = (path: string) => /\.(java|kts?)$/.test(path);

/** Which language a module-wide file's types live with: a Ruby class is never a Swift type. */
const moduleOf = (path: string) => (path.endsWith(".swift") ? "swift" : "ruby");

/** The method a language runs on construction: `Foo.new`, `Foo(…)`, `new Foo()`. */
function isConstructor(symbol: SymbolRef): boolean {
  const { path, name } = symbol;
  if (path.endsWith(".php")) return name === "__construct";
  if (/\.(rb|rake)$/.test(path)) return name === "initialize";
  if (path.endsWith(".swift")) return name === "init";
  if (path.endsWith(".java")) return name === symbol.container;
  if (/\.kts?$/.test(path)) return name === "constructor";
  return false;
}

/** Class methods that hand back an instance: `Rule.find(id).apply`, `Store.shared.fetch()`. */
const INSTANCE_GETTERS = new Set([
  "new",
  "find",
  "find_by",
  "find_by!",
  "find_or_create_by",
  "find_or_create_by!",
  "first",
  "last",
  "take",
  "sole",
  "create",
  "create!",
  "shared",
  "instance",
  "getInstance",
  "default",
  "current",
]);

/** Whether a call's receiver is one of the classes, or an instance one of them just handed back. */
function onClass(object: string, classes: Set<string>): boolean {
  // `Rule::Runner.new` is Runner's: the namespace in front of a class doesn't count as a step.
  const parts = object
    .replace(/\([^()]*\)/g, "")
    .split(/&?\./)
    .map((part) => part.split("::").at(-1) ?? part)
    .filter(Boolean);
  const last = parts.at(-1) ?? object;
  if (classes.has(last)) return true;
  return parts.length === 2 && classes.has(parts[0] ?? "") && INSTANCE_GETTERS.has(last);
}

/** The class in a Ruby receiver that `onClass` matched: `Rule` in `Rule` or `Rule.find(id)`. */
function rubyReceiverClass(object: string): string | undefined {
  const parts = object
    .replace(/\([^()]*\)/g, "")
    .split(/&?\./)
    .filter(Boolean);
  const last = parts.at(-1) ?? object;
  if (/^[A-Z]/.test(last)) return last;
  return parts.length === 2 && /^[A-Z]/.test(parts[0] ?? "") ? parts[0] : undefined;
}

/**
 * Whether a receiver is named after one of the classes: `rule`, `@rule`, `current_rule`, `self.rule` for Rule;
 * `ruleRunner` for RuleRunner. Where any file can reach any class, that's the best sign a call is on an instance.
 */
/** The declared type of `transport`, `this.transport` or `self.client?` at a line, by the innermost declaration. */
function declaredType(symbols: FileSymbols, object: string, line: number): string | undefined {
  const name = object.replace(/^(self|this)\./, "").replace(/[?!]+$/, "");
  let found: TypedVariable | undefined;
  for (const v of symbols.variables ?? []) {
    if (v.name === name && v.startLine <= line && line <= v.endLine && (!found || v.startLine >= found.startLine))
      found = v;
  }
  return found?.type;
}

/** `loadServiceMethod(m)` → `ServiceMethod`: what a function defined in the same file returns, by its signature. */
function returnType(symbols: FileSymbols, object: string): string | undefined {
  const called = object.replace(/^(self|this)\./, "").match(/^(\w+)\(.*\)[?!]*$/)?.[1];
  if (!called || /^\p{Lu}/u.test(called)) return undefined;
  const def = symbols.definitions.find((d) => d.name === called && (d.kind === "method" || d.kind === "function"));
  const signature = def?.signature?.replace(/<[^<>]*>/g, "").replace(/\s+/g, " ") ?? "";
  // Kotlin `fun f(): Foo`, Swift `func f() -> Foo`, Java `Foo f(Bar b)`.
  const written =
    signature.match(/\)\s*(?::|->)\s*([\w.]+)[?!]?\s*(?:where\b.*)?$/)?.[1] ??
    signature.match(new RegExp(`([\\w.]+)(?:\\[\\])?\\s+${called}\\s*\\(`))?.[1];
  const type = written?.split(".").at(-1);
  return type && /^\p{Lu}/u.test(type) ? type : undefined;
}

function namedLike(object: string, classes: Iterable<string>): boolean {
  const last = (object.split(/\.|::/).at(-1) ?? object)
    .replace(/^@+/, "")
    .replace(/[?!]$/, "")
    .replace(/_/g, "")
    .toLowerCase();
  for (const name of classes) {
    const wanted = name.toLowerCase();
    if (wanted.length >= 3 && (last === wanted || last.endsWith(wanted))) return true;
  }
  return false;
}

const snake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/**
 * The names a method is called by. Besides its own: an Eloquent scope `scopeActive` is called as `active()`, and on a
 * model a relationship or accessor is read as a property: `posts()` as `->posts`, `getFullNameAttribute` as
 * `->full_name`.
 */
function phpMethodNames(symbol: SymbolRef, eloquent: boolean): { calls: Set<string>; properties: Set<string> } {
  const calls = new Set([symbol.name]);
  const properties = new Set<string>();
  const scope = /^scope([A-Z]\w*)$/.exec(symbol.name)?.[1];
  if (scope) calls.add(scope.charAt(0).toLowerCase() + scope.slice(1));
  if (eloquent) {
    const accessor = /^get([A-Z]\w*)Attribute$/.exec(symbol.name)?.[1];
    if (accessor) properties.add(snake(accessor));
    else if (!scope && !symbol.name.startsWith("__")) {
      properties.add(symbol.name);
      properties.add(snake(symbol.name));
    }
  }
  return { calls, properties };
}

/** How deep to follow re-export chains (barrel files re-exporting barrel files). */
const MAX_REEXPORT_DEPTH = 4;

/** How deep to follow Go embedding: a struct embedding a struct that embeds the changed one, and so on. */
const MAX_EMBED_DEPTH = 3;

/** A Go named type, keyed "dir#Name": one directory is one package. */
interface GoType {
  path: string;
  def: Definition;
}

/** Go's types across the repo, for calls through interfaces and promoted methods. Built on first use. */
interface GoTypes {
  types: Map<string, GoType>;
  /** "dir#Type" → the methods declared with it as receiver. */
  methods: Map<string, Set<string>>;
  /** "dir#Type" → the structs embedding it. */
  embedders: Map<string, string[]>;
  /** Method name → the interfaces with that method, embedded interfaces' methods included. */
  interfacesByMethod: Map<string, string[]>;
  /** "dir#Interface" → its whole method set, as far as the repo defines it. */
  interfaceMethods: Map<string, Set<string>>;
}

/** A type (or interface) whose name can stand for the changed method's type at a call site. */
interface GoMember {
  key: string;
  ref: SymbolRef;
  via?: string;
  /** Interfaces only: the call may be on any of the interface's implementations. */
  loose?: boolean;
  /** Other interfaces in the same package the call may go through. */
  names?: string[];
}

const goTypeKey = (dir: string, name: string) => `${dir}#${name}`;

/**
 * Who uses what, across a repo's index. Resolves every import once; `callersOf` then answers from memory.
 */
export class CodeGraph {
  private readonly bindings = new Map<string, Binding[]>();

  /** Go: a package's directory → its non-test files, which share one namespace. */
  private readonly goPackages = new Map<string, string[]>();

  /** PHP facades: "file#Class" of a facade's target → the facades pointing at it. */
  private readonly facades = new Map<string, SymbolRef[]>();

  /** PHP: "file#Class" → classes that extend or implement it, or use it as a trait. */
  private readonly descendants = new Map<string, SymbolRef[]>();

  private goTypeIndex: GoTypes | undefined;

  /** Java and Kotlin: "com.acme.Foo" → the file defining it, for every top-level class, object and function. */
  private readonly jvmNames = new Map<string, string>();
  /** Swift: `$state` → the property wrapper `@Protected var state` declares, from any file (extensions use it too). */
  private readonly swiftWrappers = new Map<string, string>();

  /**
   * Ruby and Swift: "ruby#Name" → the files defining (or reopening, or extending) the type. Ruby keys by the full
   * constant path ("ruby#Rule::Runner").
   */
  private readonly moduleTypes = new Map<string, string[]>();

  /** Ruby: a class's own name → the full constant paths of every class and module with that name. */
  private readonly rubyNames = new Map<string, string[]>();

  /** Ruby: resolved constants, by file, line and constant as written. */
  private readonly rubyResolved = new Map<string, SymbolRef | undefined>();

  constructor(
    private readonly files: Map<string, FileSymbols>,
    private readonly resolve: Resolver,
  ) {
    for (const [path, symbols] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      for (const variable of symbols.variables ?? []) {
        if (variable.name.startsWith("$") && !this.swiftWrappers.has(variable.name))
          this.swiftWrappers.set(variable.name, variable.type);
      }
      for (const def of symbols.definitions) {
        if (def.extension && isJvm(path)) {
          const fqn = symbols.jvmPackage ? `${symbols.jvmPackage}.${def.name}` : def.name;
          if (!this.jvmNames.has(fqn)) this.jvmNames.set(fqn, path);
        }
        if (def.container) continue;
        if (isJvm(path)) {
          const name = def.qualified ?? def.name;
          const fqn = symbols.jvmPackage ? `${symbols.jvmPackage}.${name}` : name;
          if (!this.jvmNames.has(fqn)) this.jvmNames.set(fqn, path);
        } else if (moduleWide(path) && def.kind !== "function") {
          const key = `${moduleOf(path)}#${def.qualified ?? def.name}`;
          const list = this.moduleTypes.get(key) ?? [];
          if (!list.includes(path)) list.push(path);
          this.moduleTypes.set(key, list);
          if (moduleOf(path) === "ruby" && def.kind !== "variable") {
            const qualified = def.qualified ?? def.name;
            const names = this.rubyNames.get(def.name) ?? [];
            if (!names.includes(qualified)) names.push(qualified);
            this.rubyNames.set(def.name, names);
          }
        }
      }
    }
    for (const path of files.keys()) {
      if (!path.endsWith(".go") || path.endsWith("_test.go")) continue;
      const dir = dirOf(path);
      this.goPackages.set(dir, [...(this.goPackages.get(dir) ?? []), path]);
    }
    for (const [path, symbols] of files) {
      const list: Binding[] = [];
      if (isJvm(path)) {
        this.bindings.set(path, this.jvmBindings(symbols));
        continue;
      }
      for (const imp of symbols.imports) {
        const target = resolve(path, imp.from);
        if (target === undefined) continue;
        if (symbols.language === "go") {
          // A Go import names a package: bind it to every file in the package, under the package's declared name
          // when no alias was written (the directory name is only a convention).
          const members = this.goPackages.get(target) ?? [];
          const declared = members.map((m) => files.get(m)?.goPackage).find(Boolean);
          const local = imp.implicitName && declared ? declared : imp.local;
          for (const member of members) {
            list.push({ local, namespace: true, target: member, imported: "*", reexport: false, line: imp.line });
          }
          continue;
        }
        // Python `from .services import product_sync` (or `from . import product_sync`) may name a submodule
        // rather than something the package defines: then `product_sync.fn()` calls into services/product_sync.py.
        // The name binding stays too, for when __init__.py defines or re-exports it.
        if (path.endsWith(".py") && imp.imported !== "*") {
          const submodule = resolve(path, `${imp.from}${imp.from.endsWith(".") ? "" : "."}${imp.imported}`);
          if (submodule !== undefined && submodule !== target) {
            list.push({
              local: imp.local,
              namespace: true,
              target: submodule,
              imported: "*",
              reexport: false,
              line: imp.line,
            });
          }
        }
        // Python `import a.b` binds "a" but calls look like a.b.fn(), so the object to match is the module path.
        const pythonModule = path.endsWith(".py") && imp.imported === "*" && imp.local === imp.from.split(".")[0];
        list.push({
          local: pythonModule ? imp.from : imp.local,
          namespace: imp.imported === "*",
          target,
          imported: imp.imported,
          // In Python a name a module imports can be imported from it in turn (how packages expose things through
          // __init__.py), so every named import passes the name on.
          reexport: imp.reexport === true || (path.endsWith(".py") && imp.imported !== "*"),
          line: imp.line,
        });
      }
      this.bindings.set(path, list);
    }
    for (const [path, symbols] of files) {
      for (const def of symbols.definitions) {
        if (def.container) continue;
        for (const base of def.bases ?? []) {
          const parent = this.resolveClass(path, base);
          if (!parent) continue;
          const key = `${parent.path}#${parent.name}`;
          const child = this.rubyCanonical(path, def) ?? { path, name: def.name };
          const list = this.descendants.get(key) ?? [];
          if (!list.some((c) => c.path === child.path && c.name === child.name)) list.push(child);
          this.descendants.set(key, list);
        }
        if (!def.facadeFor) continue;
        const target = this.resolveClass(path, def.facadeFor);
        if (!target) continue;
        const key = `${target.path}#${target.name}`;
        this.facades.set(key, [...(this.facades.get(key) ?? []), { path, name: def.name }]);
      }
    }
  }

  /**
   * Java and Kotlin imports, matched against the repo's own classes and functions: `com.acme.Foo` binds Foo (or its
   * alias), `com.acme.*` binds everything top-level in the package.
   */
  private jvmBindings(symbols: FileSymbols): Binding[] {
    const list: Binding[] = [];
    for (const imp of symbols.imports) {
      if (imp.imported === "*") {
        for (const [fqn, target] of this.jvmNames) {
          const name = fqn.slice(imp.from.length + 1);
          if (!fqn.startsWith(`${imp.from}.`) || name.includes(".")) continue;
          list.push({ local: name, namespace: false, target, imported: name, reexport: false, line: imp.line });
        }
        continue;
      }
      const target = this.jvmNames.get(imp.from);
      const extension =
        target !== undefined && this.files.get(target)?.definitions.some((d) => d.extension && d.name === imp.imported);
      if (target === undefined || extension) {
        // `import pkg.Locks.withLock` (Kotlin) or `import static pkg.Util.helper` (Java): a member of a class.
        const owner = imp.from.slice(0, imp.from.lastIndexOf("."));
        const ownerFile = extension ? target : this.jvmNames.get(owner);
        if (ownerFile !== undefined) {
          list.push({
            local: imp.local,
            namespace: false,
            target: ownerFile,
            imported: owner.split(".").at(-1) ?? owner,
            reexport: false,
            line: imp.line,
            member: true,
          });
        }
        continue;
      }
      list.push({
        local: imp.local,
        namespace: false,
        target,
        imported: imp.imported,
        reexport: false,
        line: imp.line,
      });
    }
    return list;
  }

  /** A class name as written in a PHP, Ruby, Swift, Java or Kotlin file → the file defining it. */
  private resolveClass(fromFile: string, written: string, line?: number): SymbolRef | undefined {
    const symbols = this.files.get(fromFile);
    if (!symbols) return undefined;
    if (moduleOf(fromFile) === "ruby" && moduleWide(fromFile))
      return this.resolveRuby(fromFile, symbols, written, line);
    if (moduleWide(fromFile)) {
      const name = written.split(/::|\./).at(-1) ?? written;
      const path = this.moduleTypes.get(`${moduleOf(fromFile)}#${name}`)?.[0];
      return path ? { path, name } : undefined;
    }
    if (isJvm(fromFile)) {
      const name = written.split(".").at(-1) ?? written;
      // `DnsCallStateMachine.Transport`: a nested class, through its outer class.
      const [first, ...rest] = written.split(".");
      if (first && rest.length > 0 && /^\p{Lu}/u.test(first)) {
        const outer = this.resolveClass(fromFile, first);
        const qualified = [outer?.name, ...rest].join(".");
        const nested =
          outer && this.files.get(outer.path)?.definitions.find((d) => !d.container && d.qualified === qualified);
        if (outer && nested) return { path: outer.path, name: nested.name };
      }
      // A class nested in this file, named bare.
      if (symbols.definitions.some((d) => !d.container && d.name === name && d.qualified !== undefined))
        return { path: fromFile, name };
      const imported = this.bindings.get(fromFile)?.find((b) => b.local === name);
      if (imported) return { path: imported.target, name: imported.imported };
      const path = this.jvmNames.get(symbols.jvmPackage ? `${symbols.jvmPackage}.${name}` : name);
      return path ? { path, name } : undefined;
    }
    if (!fromFile.endsWith(".php")) return undefined;
    const name = written.split("\\").at(-1) ?? written;
    let fqn: string;
    if (written.startsWith("\\")) fqn = written.slice(1);
    else {
      const [first, ...rest] = written.split("\\");
      const imported = symbols.imports.find((i) => i.local === first);
      if (imported) fqn = [imported.from, ...rest].join("\\");
      else fqn = symbols.phpNamespace ? `${symbols.phpNamespace}\\${written}` : written;
    }
    const path = this.resolve(fromFile, fqn);
    return path && this.files.get(path)?.definitions.some((d) => d.name === name && !d.container)
      ? { path, name }
      : undefined;
  }

  /**
   * A Ruby constant as written at `line` (anywhere in the file without one) → the class or module it names, looked up
   * as Ruby does: in the namespaces around it, innermost first, then at the top level. `Rule::Runner` matches a class
   * whose full path ends with it. A name only one class in the repo has needs no namespace to match.
   */
  private resolveRuby(fromFile: string, symbols: FileSymbols, written: string, line?: number): SymbolRef | undefined {
    const cacheKey = `${fromFile}:${line ?? ""}:${written}`;
    if (this.rubyResolved.has(cacheKey)) return this.rubyResolved.get(cacheKey);
    const path = written.replace(/^::/, "");
    const short = path.split("::").at(-1) ?? path;
    const candidates = this.rubyNames.get(short) ?? [];
    let found: string | undefined;
    if (candidates.length === 1) found = candidates[0];
    else if (candidates.length > 1) {
      // Namespaces around the reference: each enclosing class's full path and the namespaces above it.
      const nesting: string[] = [];
      const enclosing = symbols.definitions
        .filter(
          (d) =>
            !d.container && d.kind === "class" && (line === undefined || (d.startLine <= line && line <= d.endLine)),
        )
        .sort((a, b) => b.startLine - a.startLine);
      for (const d of enclosing) {
        const parts = (d.qualified ?? d.name).split("::");
        for (let i = parts.length; i > 0; i--) {
          const ns = parts.slice(0, i).join("::");
          if (!nesting.includes(ns)) nesting.push(ns);
        }
      }
      for (const ns of nesting) {
        if (candidates.includes(`${ns}::${path}`)) {
          found = `${ns}::${path}`;
          break;
        }
      }
      found ??=
        candidates.find((c) => c === path) ?? candidates.find((c) => path.includes("::") && c.endsWith(`::${path}`));
    }
    const file = found ? this.moduleTypes.get(`ruby#${found}`)?.[0] : undefined;
    const ref = file ? { path: file, name: short } : undefined;
    this.rubyResolved.set(cacheKey, ref);
    return ref;
  }

  /** A Ruby class defined in `path` → the class as the graph keys it: the first file opening it. */
  private rubyCanonical(path: string, def: Definition): SymbolRef | undefined {
    if (moduleOf(path) !== "ruby" || !moduleWide(path)) return undefined;
    const file = this.moduleTypes.get(`ruby#${def.qualified ?? def.name}`)?.[0];
    return file ? { path: file, name: def.name } : undefined;
  }

  /** The class a Ruby method's container names, from the file defining the method. */
  private rubyClassOf(path: string, container: string, line?: number): SymbolRef | undefined {
    const defs = this.files.get(path)?.definitions ?? [];
    const def =
      defs.find(
        (d) => !d.container && d.name === container && line !== undefined && d.startLine <= line && line <= d.endLine,
      ) ?? defs.find((d) => !d.container && d.name === container);
    return def ? this.rubyCanonical(path, def) : undefined;
  }

  /**
   * The classes whose name can stand for `container` at a call site: itself, the interfaces and parents it
   * extends (a container binding or a type hint calls through those), and facades pointing at it.
   */
  private classFamily(symbol: SymbolRef, container: string): SymbolRef[] {
    // A Ruby class or Swift type can be opened in several files; the graph keys it by the first.
    const start = moduleWide(symbol.path)
      ? (this.rubyClassOf(symbol.path, container) ??
        this.resolveClass(symbol.path, container) ?? { path: symbol.path, name: container })
      : { path: symbol.path, name: container };
    const family: SymbolRef[] = [start, ...this.parentsOf(start)];
    // Downwards too: subclasses and classes using it as a trait inherit the method, so `$song->album` reaches a
    // relationship defined in a trait Song uses (and a Ruby concern's methods reach the models including it).
    const seen = new Set([`${start.path}#${start.name}`]);
    let frontier = [start];
    for (let depth = 0; depth < 4 && frontier.length > 0; depth++) {
      const next: SymbolRef[] = [];
      for (const member of frontier) {
        for (const child of this.descendants.get(`${member.path}#${member.name}`) ?? []) {
          const key = `${child.path}#${child.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          family.push(child);
          next.push(child);
        }
      }
      frontier = next;
    }
    for (const member of [...family]) family.push(...(this.facades.get(`${member.path}#${member.name}`) ?? []));
    return family;
  }

  /** The classes, interfaces and modules a class extends, implements or mixes in, that the repo defines. */
  private parentsOf(ref: SymbolRef): SymbolRef[] {
    return this.basesOf(ref).flatMap((base) => this.resolveClass(ref.path, base) ?? []);
  }

  /** What a class extends, implements or mixes in, across every file that opens it (Ruby, Swift). */
  private basesOf(ref: SymbolRef): string[] {
    const own = this.files.get(ref.path)?.definitions.find((d) => d.name === ref.name && !d.container);
    const paths = moduleWide(ref.path)
      ? (this.moduleTypes.get(`${moduleOf(ref.path)}#${own?.qualified ?? ref.name}`) ?? [])
      : [ref.path];
    return paths.flatMap(
      (path) => this.files.get(path)?.definitions.find((d) => d.name === ref.name && !d.container)?.bases ?? [],
    );
  }

  /** Ruby: whether `line` is inside one of the classes, by the innermost class or module around it. */
  private insideRubyClass(path: string, symbols: FileSymbols, line: number, keys: Set<string>): boolean {
    const around = symbols.definitions
      .filter((d) => !d.container && d.kind === "class" && d.startLine <= line && line <= d.endLine)
      .sort((a, b) => b.startLine - a.startLine)[0];
    const ref = around ? this.rubyCanonical(path, around) : undefined;
    return ref !== undefined && keys.has(`${ref.path}#${ref.name}`);
  }

  /** Whether `line` is inside one of the classes (or a method declared for one, such as a Kotlin extension). */
  private insideClass(symbols: FileSymbols, line: number, classes: Set<string>): boolean {
    return symbols.definitions.some(
      (d) =>
        classes.has(d.container ?? d.name) &&
        (d.container !== undefined || d.kind === "class" || d.kind === "interface") &&
        d.startLine <= line &&
        line <= d.endLine,
    );
  }

  /** An Eloquent model: extends Model (or a class named like one), Authenticatable or Pivot, possibly via parents. */
  private isEloquent(path: string, className: string, depth = 0): boolean {
    // A trait counts when a model uses it.
    if (depth === 0) {
      for (const user of this.descendants.get(`${path}#${className}`) ?? []) {
        if (this.isEloquent(user.path, user.name, 1)) return true;
      }
    }
    const def = this.files.get(path)?.definitions.find((d) => d.name === className && !d.container);
    for (const base of def?.bases ?? []) {
      const short = base.split("\\").at(-1) ?? base;
      if (/Model$|^Authenticatable$|^Pivot$/.test(short)) return true;
      const parent = depth < 4 ? this.resolveClass(path, base) : undefined;
      if (parent && this.isEloquent(parent.path, parent.name, depth + 1)) return true;
    }
    return false;
  }

  /** Whether `object` at `line` is the receiver of one of the symbol's type's own methods (same package only). */
  private isGoReceiver(path: string, symbols: FileSymbols, symbol: SymbolRef, object: string, line: number): boolean {
    if (!this.samePackage(path, symbol.path)) return false;
    return symbols.definitions.some(
      (d) => d.container === symbol.container && d.receiver === object && d.startLine <= line && line <= d.endLine,
    );
  }

  /** A Go type name as written in `fromFile` (`Inner`, `pkg.Inner`) → "dir#Name", through the file's imports. */
  private goTypeRef(fromFile: string, written: string): string {
    const dot = written.indexOf(".");
    if (dot === -1) return goTypeKey(dirOf(fromFile), written);
    const local = written.slice(0, dot);
    const binding = this.bindings.get(fromFile)?.find((b) => b.namespace && b.local === local);
    // An external package's type (io.Reader): keyed by the package name, which matches nothing in the repo.
    return goTypeKey(binding ? dirOf(binding.target) : `external:${local}`, written.slice(dot + 1));
  }

  private goTypes(): GoTypes {
    if (this.goTypeIndex) return this.goTypeIndex;
    const types = new Map<string, GoType>();
    const methods = new Map<string, Set<string>>();
    const embedders = new Map<string, string[]>();
    for (const [dir, members] of this.goPackages) {
      for (const path of members) {
        for (const def of this.files.get(path)?.definitions ?? []) {
          if (def.container) {
            const key = goTypeKey(dir, def.container);
            const set = methods.get(key) ?? new Set();
            set.add(def.name);
            methods.set(key, set);
          } else if (def.kind === "class" || def.kind === "interface") {
            types.set(goTypeKey(dir, def.name), { path, def });
          }
        }
      }
    }
    for (const [key, type] of types) {
      if (type.def.kind !== "class") continue;
      for (const base of type.def.bases ?? []) {
        const inner = this.goTypeRef(type.path, base);
        embedders.set(inner, [...(embedders.get(inner) ?? []), key]);
      }
    }
    // An interface's method set includes the interfaces it embeds. Embedded interfaces from outside the repo
    // (io.Reader) add methods we can't see, so they're left out: matching is on the methods the repo declares.
    const interfaceMethods = new Map<string, Set<string>>();
    const methodSetOf = (key: string, depth: number): Set<string> => {
      const known = interfaceMethods.get(key);
      if (known) return known;
      const type = types.get(key);
      const set = new Set(type?.def.methods ?? []);
      if (type && depth < MAX_EMBED_DEPTH) {
        for (const base of type.def.bases ?? []) {
          const inner = this.goTypeRef(type.path, base);
          if (types.get(inner)?.def.kind === "interface") for (const m of methodSetOf(inner, depth + 1)) set.add(m);
        }
      }
      if (depth === 0) interfaceMethods.set(key, set);
      return set;
    };
    const interfacesByMethod = new Map<string, string[]>();
    for (const [key, type] of types) {
      if (type.def.kind !== "interface") continue;
      for (const m of methodSetOf(key, 0)) interfacesByMethod.set(m, [...(interfacesByMethod.get(m) ?? []), key]);
    }
    this.goTypeIndex = { types, methods, embedders, interfacesByMethod, interfaceMethods };
    return this.goTypeIndex;
  }

  /** A Go type's methods, its own and those promoted from the structs it embeds. */
  private goMethodSet(key: string, depth = 0): Set<string> {
    const { types, methods } = this.goTypes();
    const set = new Set(methods.get(key) ?? []);
    const type = types.get(key);
    if (type?.def.kind === "class" && depth < MAX_EMBED_DEPTH) {
      for (const base of type.def.bases ?? []) {
        const inner = this.goTypeRef(type.path, base);
        // An embedded interface brings its methods too, implemented by whatever value the field holds.
        for (const m of this.goTypes().interfaceMethods.get(inner) ?? this.goMethodSet(inner, depth + 1)) set.add(m);
      }
    }
    return set;
  }

  /**
   * The Go types a call to `symbol` (a method) can be made through, besides its own: structs embedding its type, which
   * get the method unless they declare their own, and interfaces it implements, judged by method names (the repo's
   * interfaces only; Alden doesn't check parameter types).
   */
  private goFamily(symbol: SymbolRef & { container: string }): GoMember[] {
    const { types, embedders, interfacesByMethod, interfaceMethods, methods } = this.goTypes();
    const own = goTypeKey(dirOf(symbol.path), symbol.container);
    const family: GoMember[] = [{ key: own, ref: { path: symbol.path, name: symbol.container } }];
    const seen = new Set([own]);
    let frontier = [own];
    for (let depth = 0; depth < MAX_EMBED_DEPTH && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const inner of frontier) {
        for (const outer of embedders.get(inner) ?? []) {
          // An outer type declaring the same method shadows the promoted one.
          if (seen.has(outer) || methods.get(outer)?.has(symbol.name)) continue;
          seen.add(outer);
          const type = types.get(outer);
          if (!type) continue;
          family.push({
            key: outer,
            ref: { path: type.path, name: type.def.name },
            via: `${type.def.name} (embeds ${symbol.container})`,
          });
          next.push(outer);
        }
      }
      frontier = next;
    }
    if (GO_COMMON_METHODS.has(symbol.name) || GO_INTERFACE_COMMON.has(symbol.name)) return family;
    const implementers = family.map((m) => this.goMethodSet(m.key));
    for (const key of interfacesByMethod.get(symbol.name) ?? []) {
      const type = types.get(key);
      const wanted = interfaceMethods.get(key);
      if (!type || !wanted || seen.has(key)) continue;
      if (!implementers.some((set) => [...wanted].every((m) => set.has(m)))) continue;
      seen.add(key);
      family.push({
        key,
        ref: { path: type.path, name: type.def.name },
        via: `interface ${type.def.name}`,
        loose: true,
      });
    }
    return family;
  }

  /**
   * Go: one directory is one package. PHP: one namespace, whose classes need no `use` for each other. Java and Kotlin:
   * one `package`. Ruby and Swift: the whole app or module.
   */
  private samePackage(a: string, b: string): boolean {
    if (a.endsWith(".go") && b.endsWith(".go")) return dirOf(a) === dirOf(b);
    if (a.endsWith(".php") && b.endsWith(".php")) {
      const namespace = this.files.get(a)?.phpNamespace;
      return namespace !== undefined && namespace === this.files.get(b)?.phpNamespace;
    }
    if (moduleWide(a) && moduleWide(b)) return moduleOf(a) === moduleOf(b);
    if (isJvm(a) && isJvm(b)) return this.files.get(a)?.jvmPackage === this.files.get(b)?.jvmPackage;
    return false;
  }

  /** Every (file, name) under which a symbol can be imported: its own file, plus re-exports of it. */
  private exportedAs(symbol: SymbolRef): Map<string, Set<string>> {
    const found = new Map<string, Set<string>>([[symbol.path, new Set([symbol.name])]]);
    let frontier: [string, string][] = [[symbol.path, symbol.name]];
    for (let depth = 0; depth < MAX_REEXPORT_DEPTH && frontier.length > 0; depth++) {
      const next: [string, string][] = [];
      for (const [file, bindings] of this.bindings) {
        for (const b of bindings) {
          if (!b.reexport) continue;
          for (const [target, name] of frontier) {
            if (b.target !== target) continue;
            // `export * from "./x"` passes every name through; `export { a as b }` renames one.
            const exposed = b.imported === "*" ? name : b.imported === name ? b.local : undefined;
            if (!exposed) continue;
            const names = found.get(file) ?? new Set();
            if (!names.has(exposed)) {
              names.add(exposed);
              found.set(file, names);
              next.push([file, exposed]);
            }
          }
        }
      }
      frontier = next;
    }
    return found;
  }

  /**
   * The files importing each of `paths` (one site per importing file: its first import of it), in one pass over the
   * imports resolved when the graph was built. A Go import names a package, so it imports every file in it. Import
   * lines in `exclude` (the diff's own changes) don't count, and neither does a file importing itself.
   */
  importersOf(paths: Iterable<string>, exclude: Map<string, Set<number>> = new Map()): Map<string, CallSite[]> {
    const found = new Map<string, CallSite[]>([...paths].map((p) => [p, []]));
    for (const [path, bindings] of this.bindings) {
      for (const b of bindings) {
        const sites = found.get(b.target);
        if (!sites || b.target === path || exclude.get(path)?.has(b.line)) continue;
        const existing = sites.find((s) => s.path === path);
        if (!existing) sites.push({ path, line: b.line, confidence: "import" });
        else if (b.line < existing.line) existing.line = b.line;
      }
    }
    for (const sites of found.values()) sites.sort((a, b) => a.path.localeCompare(b.path));
    return found;
  }

  /**
   * Places that use `symbol`, excluding lines in `exclude` (the diff's own changed lines, which were updated along
   * with the change). Functions and classes: calls through imports, namespace imports and within their own file.
   * Methods: `something.method(...)` in files that import the class, and in the class's own file.
   */
  callersOf(symbol: SymbolRef, exclude: Map<string, Set<number>> = new Map()): CallSite[] {
    const sites: CallSite[] = [];
    const seen = new Set<string>();
    const add = (path: string, line: number, confidence: CallSite["confidence"], via?: string) => {
      const id = `${path}:${line}`;
      if (exclude.get(path)?.has(line)) return;
      if (seen.has(id)) {
        // A sure match on a line beats an uncertain one on the same line.
        const site = sites.find((s) => s.path === path && s.line === line);
        if (site && confidence === "import" && site.confidence === "name") {
          site.confidence = "import";
          if (via) site.via = via;
          else delete site.via;
        }
        return;
      }
      seen.add(id);
      sites.push({ path, line, confidence, ...(via ? { via } : {}) });
    };

    const lookFor = symbol.container ?? symbol.name;
    const isMethod = symbol.container !== undefined;
    const isPhp = symbol.path.endsWith(".php");
    const isGo = symbol.path.endsWith(".go");
    // Ruby, Swift, Java and Kotlin: methods are called on instances whose type the graph doesn't track, and without a
    // receiver from inside the class.
    const typed = moduleWide(symbol.path) || isJvm(symbol.path);
    // PHP methods are also reached through interfaces, parents and facades; Go methods through the interfaces their
    // type implements and the structs embedding it; everything else through its own name.
    const goMembers = isMethod && isGo ? this.goFamily({ ...symbol, container: lookFor }) : undefined;
    // Go: which of those a package's files reach, first match wins (the type itself, then embedders, interfaces).
    const goByDir = new Map<string, GoMember>();
    for (const member of goMembers ?? []) {
      const dir = dirOf(member.ref.path);
      const first = goByDir.get(dir);
      if (!first) goByDir.set(dir, member);
      // Several interfaces in one package: name a few, since the call may go through any.
      else if (first.loose && member.loose)
        goByDir.set(dir, { ...first, names: [...(first.names ?? []), member.ref.name] });
    }
    for (const member of goByDir.values()) {
      const extra = member.names ?? [];
      if (extra.length === 0) continue;
      const shown = extra.slice(0, 2).join(", ");
      member.via = `${member.via}, ${shown}${extra.length > 2 ? ` and ${extra.length - 2} more` : ""}`;
    }
    const family = goMembers
      ? goMembers.map((m) => m.ref)
      : isMethod && (isPhp || typed)
        ? this.classFamily(symbol, lookFor)
        : [{ path: symbol.path, name: lookFor }];
    const exported = new Map<string, Set<string>>();
    for (const member of family) {
      for (const [file, names] of this.exportedAs(member)) {
        exported.set(file, new Set([...(exported.get(file) ?? []), ...names]));
      }
    }
    // Go: `Type.Method` (a method expression) is the type itself only in its own package; elsewhere a bare `check` is
    // a variable that happens to share an unexported type's name. Interfaces and embedders don't count as the type.
    const classNames = new Set(goMembers ? [] : family.map((m) => m.name));
    const familyPaths = new Set(family.map((m) => m.path));
    // Ruby, Swift, Java, Kotlin: a receiver named after a parent class (`function.call` for a subclass's `call`) may
    // reach the method, or a sibling's; only the class itself and its descendants make a sure match.
    const parents =
      typed && isMethod ? new Set(this.parentsOf({ path: symbol.path, name: lookFor }).map((p) => p.name)) : undefined;
    const ownNames = new Set([...classNames].filter((n) => n === lookFor || !parents?.has(n)));
    // Ruby: which classes those are, so `Plaid::Processor.new` doesn't count for `Redbark::Processor`.
    const ruby = typed && moduleOf(symbol.path) === "ruby" && moduleWide(symbol.path);
    const keyOf = (r: SymbolRef) => `${r.path}#${r.name}`;
    const parentKeys = new Set(
      typed && isMethod ? this.parentsOf(family[0] ?? { path: symbol.path, name: lookFor }).map(keyOf) : [],
    );
    const familyKeys = new Set(family.map(keyOf));
    const ownKeys = new Set(family.filter((m, i) => i === 0 || !parentKeys.has(keyOf(m))).map(keyOf));
    // Java and Kotlin: the classes a nested class sits in (`MockResponse` for `MockResponse.Builder`), which is what
    // files import.
    const outerNames = new Set(
      family.flatMap(
        (m) =>
          this.files
            .get(m.path)
            ?.definitions.find((d) => d.name === m.name && !d.container)
            ?.qualified?.split(".")
            .slice(0, -1) ?? [],
      ),
    );
    const constructs = isMethod && isConstructor(symbol);
    const extension = this.files
      .get(symbol.path)
      ?.definitions.some((d) => d.extension && d.name === symbol.name && d.container === symbol.container);
    const methodNames = !isMethod
      ? undefined
      : isPhp
        ? phpMethodNames(symbol, this.isEloquent(symbol.path, lookFor))
        : { calls: new Set([symbol.name]), properties: new Set<string>() };

    // Go: an unexported name (lowercase) is usable only in its own package, whatever another package imports.
    const packageOnly = isGo && !/^\p{Lu}/u.test(symbol.name);
    for (const [path, symbols] of this.files) {
      if (packageOnly && !this.samePackage(path, symbol.path)) continue;
      // Names in this file that mean the symbol (or its class): named imports and namespace objects.
      const names = new Set<string>();
      const namespaces = new Set<string>();
      // Its own file, and its package: Go directories and PHP namespaces share their names without imports.
      for (const member of family) {
        if (path === member.path || this.samePackage(path, member.path)) names.add(member.name);
      }
      for (const b of this.bindings.get(path) ?? []) {
        const names_ = exported.get(b.target);
        if (!names_) continue;
        if (b.namespace) namespaces.add(b.local);
        else if (names_.has(b.imported) || outerNames.has(b.imported)) names.add(b.local);
        else if (b.member && b.local === symbol.name && familyPaths.has(b.target)) names.add(b.local);
      }
      if (names.size === 0 && namespaces.size === 0) continue;
      // Go: the closest way this file reaches the method, by its own package and the packages it imports.
      let member: GoMember | undefined;
      if (goMembers) {
        const order = (m: GoMember | undefined) =>
          m ? goMembers.findIndex((g) => g.key === m.key) : Number.POSITIVE_INFINITY;
        for (const dir of [dirOf(path), ...(this.bindings.get(path) ?? []).map((b) => dirOf(b.target))]) {
          const candidate = goByDir.get(dir);
          if (order(candidate) < order(member)) member = candidate;
        }
      }

      // Java and Kotlin: a file that imports the class by name (not just shares its package) uses it on purpose.
      const importsClass = (this.bindings.get(path) ?? []).some(
        (b) => familyPaths.has(b.target) && !b.member && (classNames.has(b.imported) || outerNames.has(b.imported)),
      );
      // A method imported by name is called as itself: `withLock { … }`, `lock.withLock { … }` for an extension.
      const importsMember =
        typed &&
        (this.bindings.get(path) ?? []).some((b) => b.member && familyPaths.has(b.target) && b.local === symbol.name);
      // Ruby and Swift: whether the file names the class at all, which a name match then needs.
      let mentions: boolean | undefined;
      const mentionsClass = () =>
        (mentions ??= symbols.references.some(
          (r) => classNames.has(r.name) || (r.object !== undefined && onClass(r.object, classNames)),
        ));

      for (const ref of symbols.references) {
        if (isMethod && methodNames) {
          // A constructor runs on `new Class(...)` (`Class.new`, `Class(...)`), and PHP's on `parent::__construct()`.
          if (constructs && ref.kind === "new" && names.has(ref.name)) {
            const made = ruby ? this.resolveClass(path, ref.qualified ?? ref.name, ref.line) : undefined;
            if (!ruby || (made && ownKeys.has(keyOf(made)))) add(path, ref.line, "import");
            continue;
          }
          if (typed) {
            if (ref.kind === "type" || ref.kind === "new" || !methodNames.calls.has(ref.name)) continue;
            // A Kotlin extension function is also called bare from its own package, on an implicit receiver.
            if (importsMember || (extension && ref.object === undefined && this.samePackage(path, symbol.path))) {
              add(path, ref.line, "import");
              continue;
            }
            // No receiver, or self/this: the class's own method only from inside the class (or a subclass, a
            // module including it, a Kotlin extension of it).
            if (ref.object === undefined || SELF_NAMES.has(ref.object)) {
              const inside = ruby
                ? this.insideRubyClass(path, symbols, ref.line, ownKeys)
                : this.insideClass(symbols, ref.line, ownNames);
              if (inside) add(path, ref.line, "import");
              continue;
            }
            const common = isJvm(symbol.path)
              ? JVM_COMMON_METHODS
              : symbol.path.endsWith(".swift")
                ? SWIFT_COMMON_METHODS
                : RUBY_COMMON_METHODS;
            // `Rule.apply_all` or `rule.apply`: on the class, or on something named like it. Anything else is a name
            // match, and only for names rare enough to mean something: through a parent class, in a file importing
            // the class, or (where every file sees every class) in a file that at least names it.
            const on = (names_: Set<string>, keys: Set<string>) => {
              if (!onClass(ref.object ?? "", names_)) return false;
              if (!ruby) return true;
              const written = ref.qualified ?? rubyReceiverClass(ref.object ?? "");
              const target = written ? this.resolveClass(path, written, ref.line) : undefined;
              return target !== undefined && keys.has(keyOf(target));
            };
            // Swift, Java, Kotlin: a receiver declared with a type is that type, whatever it's named.
            const declared = ruby
              ? undefined
              : (declaredType(symbols, ref.object, ref.line) ??
                this.swiftWrappers.get(ref.object.replace(/^self\./, "")) ??
                returnType(symbols, ref.object));
            if (declared !== undefined) {
              if (ownNames.has(declared)) add(path, ref.line, "import");
              // Declared as a parent or interface: the call may dispatch to this class, however common the name.
              else if (classNames.has(declared)) add(path, ref.line, "name");
              continue;
            }
            if (on(ownNames, ownKeys) || namedLike(ref.object, ownNames)) add(path, ref.line, "import");
            else if (common.has(ref.name)) continue;
            else if (on(classNames, familyKeys) || namedLike(ref.object, classNames)) add(path, ref.line, "name");
            else if (importsClass) add(path, ref.line, "import");
            // Swift's `.chunked(size)` names a member of a type only the context knows.
            else if (ref.object === ".") add(path, ref.line, "name");
            else if (!moduleWide(symbol.path) || mentionsClass()) add(path, ref.line, "name");
            continue;
          }
          const asProperty = ref.kind === "property";
          if (!(asProperty ? methodNames.properties : methodNames.calls).has(ref.name) || ref.object === undefined)
            continue;
          // parent::x() in the class's own file is its parent's x, not this one.
          if (ref.object === "parent" && path === symbol.path) continue;
          // Any receiver may be an instance, except for names so common (get, save, filter…) that only a call on
          // exactly self/this/cls/Class is trustworthy: `this.get()` is the method, `this.data.get()` is not. In Go
          // the receiver variable (`s` in `func (s *Server)`) plays the part of `this`.
          const selfish =
            SELF_NAMES.has(ref.object) ||
            names.has(ref.object) ||
            classNames.has(ref.object) ||
            (goMembers !== undefined && ref.object === lookFor && this.samePackage(path, symbol.path)) ||
            (symbols.language === "go" && this.isGoReceiver(path, symbols, symbol, ref.object, ref.line));
          const common =
            symbols.language === "go"
              ? GO_COMMON_METHODS
              : symbols.language === "php"
                ? PHP_COMMON_METHODS
                : COMMON_METHODS;
          // A property read only means the method on an Eloquent model, and even then it may be another model's. In
          // Go, `x.Method` named without a call may as well be a field read, and a call through an interface may
          // reach any of its implementations: unless on the receiver or the type itself, those are name matches.
          const loose = asProperty || (!selfish && (ref.kind === "value" || member?.loose === true));
          if (selfish || !common.has(ref.name)) add(path, ref.line, loose ? "name" : "import", member?.via);
        } else if (
          ref.kind !== "property" &&
          (ref.object === undefined
            ? names.has(ref.name)
            : // ns.fn(), or the symbol as the object of a call: Schema.parse(), Model.objects.filter(), Klass.create()
              (namespaces.has(ref.object) && ref.name === lookFor) || names.has(ref.object.split(".")[0] ?? ""))
        ) {
          add(path, ref.line, "import");
        }
      }
    }

    // Name-only matches: files calling a bare function of that name with no import resolving to anything we know.
    // Not for Go: a bare name in another package is always that package's own symbol.
    if (!isMethod && symbol.name.length >= 4 && !symbol.path.endsWith(".go")) {
      for (const [path, symbols] of this.files) {
        if (path === symbol.path || sites.some((s) => s.path === path)) continue;
        if (symbols.definitions.some((d) => d.name === symbol.name && !d.container)) continue;
        // Imported from somewhere else (an external package, another module): a different symbol.
        if (symbols.imports.some((i) => i.local === symbol.name)) continue;
        for (const ref of symbols.references) {
          if (ref.object === undefined && ref.name === symbol.name) add(path, ref.line, "name");
        }
      }
    }
    return sites.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  }
}
