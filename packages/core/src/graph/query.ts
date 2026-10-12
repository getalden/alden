import type { Definition, FileSymbols } from "./extract.js";
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

/** Receivers that mean "this object or class" in any language. */
const SELF_NAMES = new Set(["self", "this", "cls", "$this", "static", "parent"]);

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

  constructor(
    private readonly files: Map<string, FileSymbols>,
    private readonly resolve: Resolver,
  ) {
    for (const path of files.keys()) {
      if (!path.endsWith(".go") || path.endsWith("_test.go")) continue;
      const dir = dirOf(path);
      this.goPackages.set(dir, [...(this.goPackages.get(dir) ?? []), path]);
    }
    for (const [path, symbols] of files) {
      const list: Binding[] = [];
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
          this.descendants.set(key, [...(this.descendants.get(key) ?? []), { path, name: def.name }]);
        }
        if (!def.facadeFor) continue;
        const target = this.resolveClass(path, def.facadeFor);
        if (!target) continue;
        const key = `${target.path}#${target.name}`;
        this.facades.set(key, [...(this.facades.get(key) ?? []), { path, name: def.name }]);
      }
    }
  }

  /** A class name as written in a PHP file (imported, relative to its namespace, or fully qualified) → its file. */
  private resolveClass(fromFile: string, written: string): SymbolRef | undefined {
    const symbols = this.files.get(fromFile);
    if (!symbols || !fromFile.endsWith(".php")) return undefined;
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
   * The classes whose name can stand for `container` at a call site: itself, the interfaces and parents it
   * extends (a container binding or a type hint calls through those), and facades pointing at it.
   */
  private classFamily(symbol: SymbolRef, container: string): SymbolRef[] {
    const family: SymbolRef[] = [{ path: symbol.path, name: container }];
    const def = this.files.get(symbol.path)?.definitions.find((d) => d.name === container && !d.container);
    for (const base of def?.bases ?? []) {
      const resolved = this.resolveClass(symbol.path, base);
      if (resolved) family.push(resolved);
    }
    // Downwards too: subclasses and classes using it as a trait inherit the method, so `$song->album` reaches a
    // relationship defined in a trait Song uses.
    const seen = new Set([`${symbol.path}#${container}`]);
    let frontier = [{ path: symbol.path, name: container }];
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

  /** Go: one directory is one package. PHP: one namespace, whose classes need no `use` for each other. */
  private samePackage(a: string, b: string): boolean {
    if (a.endsWith(".go") && b.endsWith(".go")) return dirOf(a) === dirOf(b);
    if (a.endsWith(".php") && b.endsWith(".php")) {
      const namespace = this.files.get(a)?.phpNamespace;
      return namespace !== undefined && namespace === this.files.get(b)?.phpNamespace;
    }
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
      : isMethod && isPhp
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
        else if (names_.has(b.imported)) names.add(b.local);
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

      for (const ref of symbols.references) {
        if (isMethod && methodNames) {
          // A PHP constructor runs on `new Class(...)` and `parent::__construct()`.
          if (symbol.name === "__construct" && ref.kind === "new" && names.has(ref.name)) {
            add(path, ref.line, "import");
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
