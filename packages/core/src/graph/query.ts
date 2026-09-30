import type { FileSymbols } from "./extract.js";
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

/** How deep to follow re-export chains (barrel files re-exporting barrel files). */
const MAX_REEXPORT_DEPTH = 4;

/**
 * Who uses what, across a repo's index. Resolves every import once; `callersOf` then answers from memory.
 */
export class CodeGraph {
  private readonly bindings = new Map<string, Binding[]>();

  /** Go: a package's directory → its non-test files, which share one namespace. */
  private readonly goPackages = new Map<string, string[]>();

  constructor(
    private readonly files: Map<string, FileSymbols>,
    resolve: Resolver,
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
            list.push({ local, namespace: true, target: member, imported: "*", reexport: false });
          }
          continue;
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
        });
      }
      this.bindings.set(path, list);
    }
  }

  /** Whether `object` at `line` is the receiver of one of the symbol's type's own methods (same package only). */
  private isGoReceiver(path: string, symbols: FileSymbols, symbol: SymbolRef, object: string, line: number): boolean {
    if (!this.samePackage(path, symbol.path)) return false;
    return symbols.definitions.some(
      (d) => d.container === symbol.container && d.receiver === object && d.startLine <= line && line <= d.endLine,
    );
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
   * Places that use `symbol`, excluding lines in `exclude` (the diff's own changed lines, which were updated along
   * with the change). Functions and classes: calls through imports, namespace imports and within their own file.
   * Methods: `something.method(...)` in files that import the class, and in the class's own file.
   */
  callersOf(symbol: SymbolRef, exclude: Map<string, Set<number>> = new Map()): CallSite[] {
    const sites: CallSite[] = [];
    const seen = new Set<string>();
    const add = (path: string, line: number, confidence: CallSite["confidence"]) => {
      const id = `${path}:${line}`;
      if (seen.has(id) || exclude.get(path)?.has(line)) return;
      seen.add(id);
      sites.push({ path, line, confidence });
    };

    const lookFor = symbol.container ?? symbol.name;
    const exported = this.exportedAs({ path: symbol.path, name: lookFor });
    const isMethod = symbol.container !== undefined;

    for (const [path, symbols] of this.files) {
      // Names in this file that mean the symbol (or its class): named imports and namespace objects.
      const names = new Set<string>();
      const namespaces = new Set<string>();
      // Its own file, and its package: Go directories and PHP namespaces share their names without imports.
      if (path === symbol.path || this.samePackage(path, symbol.path)) names.add(lookFor);
      for (const b of this.bindings.get(path) ?? []) {
        const names_ = exported.get(b.target);
        if (!names_) continue;
        if (b.namespace) namespaces.add(b.local);
        else if (names_.has(b.imported)) names.add(b.local);
      }
      if (names.size === 0 && namespaces.size === 0) continue;

      for (const ref of symbols.references) {
        if (isMethod) {
          if (ref.name !== symbol.name || ref.object === undefined) continue;
          // Any receiver may be an instance, except for names so common (get, save, filter…) that only a call on
          // exactly self/this/cls/Class is trustworthy: `this.get()` is the method, `this.data.get()` is not. In Go
          // the receiver variable (`s` in `func (s *Server)`) plays the part of `this`.
          const selfish =
            ["self", "this", "cls", lookFor].includes(ref.object) ||
            (symbols.language === "go" && this.isGoReceiver(path, symbols, symbol, ref.object, ref.line));
          const common = symbols.language === "go" ? GO_COMMON_METHODS : COMMON_METHODS;
          if (selfish || !common.has(symbol.name)) add(path, ref.line, "import");
        } else if (
          ref.object === undefined
            ? names.has(ref.name)
            : // ns.fn(), or the symbol as the object of a call: Schema.parse(), Model.objects.filter(), Klass.create()
              (namespaces.has(ref.object) && ref.name === lookFor) || names.has(ref.object.split(".")[0] ?? "")
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
