import { type Node, Query } from "web-tree-sitter";
import { type GraphLanguage, languageOf, parserFor } from "./parser.js";

export type DefinitionKind = "function" | "class" | "method" | "variable" | "interface" | "type";

/** Something a file defines. Lines are 1-based and inclusive, matching diff line numbers. */
export interface Definition {
  name: string;
  kind: DefinitionKind;
  /** Usable from other files: exported in TS/JS, not underscore-prefixed in Python, capitalised in Go. */
  exported: boolean;
  startLine: number;
  endLine: number;
  /** The class a method belongs to. */
  container?: string;
  /** Go: the method's receiver variable (`s` in `func (s *Server) Handle()`), which plays the part of `this`. */
  receiver?: string;
  /**
   * The declaration without its body, whitespace collapsed: what callers depend on. Set where the graph knows it
   * (Go so far); elsewhere the diff-based heuristic in review/signatures.ts applies.
   */
  signature?: string;
  /**
   * Classes: what they extend and implement, as written (PHP). Go: the types a struct or interface embeds (`Inner`,
   * `pkg.Inner`, without `*` or type arguments), whose methods it gets.
   */
  bases?: string[];
  /** Go interfaces: the names of the methods they declare themselves (not those of embedded interfaces). */
  methods?: string[];
  /** PHP facades: the class `getFacadeAccessor` returns (`Foo::class`), as written. */
  facadeFor?: string;
  /**
   * Ruby classes and modules inside a namespace: the full constant path (`RedbarkAccount::Processor`), since apps
   * often have a dozen classes named `Processor`. Java and Kotlin nested classes: the path from the top-level class
   * (`MockResponse.Builder`).
   */
  qualified?: string;
  /** Kotlin: a top-level extension function (`fun NavGraphBuilder.topicScreen()`), imported by its own name. */
  extension?: boolean;
}

/** A name a file brings in from elsewhere. */
export interface ImportBinding {
  /** The name used in this file. */
  local: string;
  /** The name in the source module: a name, "default", or "*" for a whole module. */
  imported: string;
  /** The module as written: "./x", "lodash", "app.models", ".utils". */
  from: string;
  line: number;
  /** `export { x } from "./y"`: re-exported, so importers of this file may reach y. */
  reexport?: boolean;
  /**
   * Go: no alias was written, so `local` is a guess from the import path. The package's own `package` clause, when
   * the package is in the repo, is the real name.
   */
  implicitName?: boolean;
}

/**
 * A use of a name: a call, `new`, a JSX element, a base class, or passed as an argument (callbacks, Django urls). In
 * Ruby, Swift, Java and Kotlin a call without a receiver has no `object`: inside a class it's usually `self`'s method.
 */
export interface Reference {
  name: string;
  /** For `obj.name(...)`, the object's text, e.g. "ns" or "self". */
  object?: string;
  line: number;
  /**
   * PHP: what kind of use, when it isn't a call. "new" instantiates (so it calls the constructor), "type" is a type
   * hint, "property" reads a property (`$user->posts`), which Eloquent turns into a method call.
   * Go: "value" names a function or method without calling it (`Fetch: shared.FetchOptions`, `h := s.handle`,
   * `return helper`), to be called later; `x.Name` there may just as well be a field read. Ruby: "value" is a method
   * named by a symbol (`before_action :set_entry`).
   * Ruby, Swift, Java and Kotlin: "new" constructs (`Foo.new`, `Foo(…)`, `new Foo()`), "type" names a type.
   */
  kind?: "new" | "type" | "property" | "value";
  /** Ruby: the class as written with its namespace (`Rule::Runner` for `Rule::Runner.new`), when it was. */
  qualified?: string;
}

export interface FileSymbols {
  language: GraphLanguage;
  /** Go: the name in the file's `package` clause. */
  goPackage?: string;
  /** PHP: the file's namespace, e.g. "App\\Models". */
  phpNamespace?: string;
  /** Java and Kotlin: the file's `package`, e.g. "com.acme.billing". */
  jvmPackage?: string;
  definitions: Definition[];
  imports: ImportBinding[];
  references: Reference[];
  /** Swift, Java and Kotlin: variables declared with a type, or assigned a new instance of one. */
  variables?: TypedVariable[];
}

/** `val transport: Transport`, `Client client`, `let request = DataRequest(…)`: a receiver whose type is known. */
export interface TypedVariable {
  name: string;
  /** The type's last name, without generics or optionality: `Transport` for `Transport<T>?`. */
  type: string;
  /** Where the name means this variable: its class for fields, its function for parameters, its block for locals. */
  startLine: number;
  endLine: number;
}

const line = (node: Node) => node.startPosition.row + 1;
const endLine = (node: Node) => node.endPosition.row + 1;
const unquote = (text: string) => text.replace(/^['"`]|['"`]$/g, "");

// ─── TypeScript / JavaScript ─────────────────────────────────────────────────────────────────────

const TS_REFERENCES = `
  (call_expression function: (identifier) @name)
  (call_expression function: (member_expression object: (_) @object property: (property_identifier) @name))
  (call_expression function: (member_expression object: (_) @object property: (private_property_identifier) @name))
  (new_expression constructor: (identifier) @name)
  (new_expression constructor: (member_expression object: (_) @object property: (property_identifier) @name))
  (class_heritage (extends_clause value: (identifier) @name))
  (arguments (identifier) @name)
  (arguments (member_expression object: (_) @object property: (property_identifier) @name))
`;

/** Only the TSX grammar has JSX nodes; the plain TypeScript grammar rejects these patterns. */
const JSX_REFERENCES = `
  (jsx_self_closing_element name: (identifier) @name)
  (jsx_opening_element name: (identifier) @name)
`;

function isPrivateMember(node: Node): boolean {
  const name = node.childForFieldName("name");
  if (name?.type === "private_property_identifier") return true;
  return node.children.some((c) => c?.type === "accessibility_modifier" && /private|protected/.test(c.text));
}

/** Methods a class keeps to itself ("Class.method"), so a later `export { Class }` doesn't expose them. */
type PrivateMembers = Set<string>;

function tsDeclarations(node: Node, exported: boolean, out: Definition[], privateMembers: PrivateMembers): void {
  const name = node.childForFieldName("name")?.text;
  const add = (kind: DefinitionKind, n: string | undefined, container?: string, isExported = exported) => {
    if (n) {
      out.push({
        name: n,
        kind,
        exported: isExported,
        startLine: line(node),
        endLine: endLine(node),
        ...(container ? { container } : {}),
      });
    }
  };
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
      add("function", name);
      break;
    case "class_declaration":
    case "abstract_class_declaration": {
      add("class", name);
      for (const member of node.childForFieldName("body")?.namedChildren ?? []) {
        if (member && (member.type === "method_definition" || member.type === "abstract_method_signature")) {
          const methodName = member.childForFieldName("name")?.text;
          if (methodName && methodName !== "constructor") {
            const isPrivate = isPrivateMember(member);
            if (isPrivate && name) privateMembers.add(`${name}.${methodName}`);
            out.push({
              name: methodName,
              kind: "method",
              exported: exported && !isPrivate,
              startLine: line(member),
              endLine: endLine(member),
              ...(name ? { container: name } : {}),
            });
          }
        }
      }
      break;
    }
    case "interface_declaration":
      add("interface", name);
      break;
    case "type_alias_declaration":
      add("type", name);
      break;
    case "lexical_declaration":
    case "variable_declaration":
      for (const declarator of node.namedChildren) {
        if (declarator?.type !== "variable_declarator") continue;
        const value = declarator.childForFieldName("value");
        const isFunction = value !== null && /^(arrow_function|function_expression|function)$/.test(value.type);
        // Plain constants only matter when exported; function-valued ones always do.
        if (isFunction || exported) {
          out.push({
            name: declarator.childForFieldName("name")?.text ?? "",
            kind: isFunction ? "function" : "variable",
            exported,
            startLine: line(node),
            endLine: endLine(node),
          });
        }
      }
      break;
  }
}

function extractTs(root: Node): Omit<FileSymbols, "language" | "references"> {
  const definitions: Definition[] = [];
  const imports: ImportBinding[] = [];
  const exportedNames = new Set<string>();
  const privateMembers: PrivateMembers = new Set();

  for (const node of root.namedChildren) {
    if (!node) continue;
    if (node.type === "import_statement") {
      const from = unquote(node.childForFieldName("source")?.text ?? "");
      const clause = node.namedChildren.find((c) => c?.type === "import_clause");
      for (const part of clause?.namedChildren ?? []) {
        if (!part) continue;
        if (part.type === "identifier") imports.push({ local: part.text, imported: "default", from, line: line(node) });
        if (part.type === "namespace_import") {
          const local = part.namedChildren.find((c) => c?.type === "identifier")?.text;
          if (local) imports.push({ local, imported: "*", from, line: line(node) });
        }
        if (part.type === "named_imports") {
          for (const spec of part.namedChildren) {
            if (spec?.type !== "import_specifier") continue;
            const imported = spec.childForFieldName("name")?.text ?? "";
            imports.push({
              local: spec.childForFieldName("alias")?.text ?? imported,
              imported,
              from,
              line: line(node),
            });
          }
        }
      }
    } else if (node.type === "export_statement") {
      const source = node.childForFieldName("source");
      const declaration = node.childForFieldName("declaration");
      if (declaration) {
        tsDeclarations(declaration, true, definitions, privateMembers);
      } else if (source) {
        // export { a, b as c } from "./x"  /  export * from "./x"
        const from = unquote(source.text);
        const clause = node.namedChildren.find((c) => c?.type === "export_clause");
        if (!clause) imports.push({ local: "*", imported: "*", from, line: line(node), reexport: true });
        for (const spec of clause?.namedChildren ?? []) {
          if (spec?.type !== "export_specifier") continue;
          const imported = spec.childForFieldName("name")?.text ?? "";
          imports.push({
            local: spec.childForFieldName("alias")?.text ?? imported,
            imported,
            from,
            line: line(node),
            reexport: true,
          });
        }
      } else {
        // export { a, b }  /  export default a  /  export default function () {}
        const clause = node.namedChildren.find((c) => c?.type === "export_clause");
        for (const spec of clause?.namedChildren ?? []) {
          if (spec?.type === "export_specifier") exportedNames.add(spec.childForFieldName("name")?.text ?? "");
        }
        const value = node.childForFieldName("value");
        if (value?.type === "identifier") exportedNames.add(value.text);
        else if (value && /function|class/.test(value.type)) tsDeclarations(value, true, definitions, privateMembers);
      }
    } else {
      tsDeclarations(node, false, definitions, privateMembers);
    }
  }
  // `export { a, Klass }` after the declarations: export them now, and Klass's non-private methods with it.
  for (const def of definitions) {
    if (def.exported) continue;
    if (def.container) {
      def.exported = exportedNames.has(def.container) && !privateMembers.has(`${def.container}.${def.name}`);
    } else {
      def.exported = exportedNames.has(def.name);
    }
  }
  return { definitions, imports };
}

// ─── Python ──────────────────────────────────────────────────────────────────────────────────────

const PY_REFERENCES = `
  (call function: (identifier) @name)
  (call function: (attribute object: (_) @object attribute: (identifier) @name))
  (class_definition superclasses: (argument_list (identifier) @name))
  (class_definition superclasses: (argument_list (attribute attribute: (identifier) @name)))
  (call arguments: (argument_list (identifier) @name))
  (call arguments: (argument_list (attribute object: (_) @object attribute: (identifier) @name)))
  (keyword_argument value: (identifier) @name)
`;

const isPublic = (name: string) => !name.startsWith("_") || (name.startsWith("__") && name.endsWith("__"));

function extractPython(root: Node): Omit<FileSymbols, "language" | "references"> {
  const definitions: Definition[] = [];
  const imports: ImportBinding[] = [];

  const definition = (node: Node, container?: string) => {
    // A decorated definition's lines include its decorators.
    const target = node.type === "decorated_definition" ? node.childForFieldName("definition") : node;
    if (!target) return;
    const name = target.childForFieldName("name")?.text;
    if (!name) return;
    if (target.type === "function_definition") {
      definitions.push({
        name,
        kind: container ? "method" : "function",
        // Dunder methods such as __init__ count as public: changing __init__ changes every constructor call.
        exported: isPublic(name) && (!container || isPublic(container)),
        startLine: line(node),
        endLine: endLine(node),
        ...(container ? { container } : {}),
      });
    } else if (target.type === "class_definition") {
      definitions.push({
        name,
        kind: "class",
        exported: isPublic(name),
        startLine: line(node),
        endLine: endLine(node),
      });
      for (const member of target.childForFieldName("body")?.namedChildren ?? []) {
        if (member && (member.type === "function_definition" || member.type === "decorated_definition")) {
          definition(member, name);
        }
      }
    }
  };

  // Imports inside functions count too: Django code often imports there to avoid circular imports.
  const nestedImports = root
    .descendantsOfType(["import_statement", "import_from_statement"])
    .filter((n) => n !== null && n.parent?.type !== "module");
  for (const node of [...root.namedChildren, ...nestedImports]) {
    if (!node) continue;
    if (
      node.type === "function_definition" ||
      node.type === "class_definition" ||
      node.type === "decorated_definition"
    ) {
      definition(node);
    } else if (node.type === "import_statement") {
      // import a.b  /  import a.b as c
      for (const name of node.namedChildren) {
        if (!name) continue;
        if (name.type === "dotted_name") {
          imports.push({
            local: name.text.split(".")[0] ?? name.text,
            imported: "*",
            from: name.text,
            line: line(node),
          });
        } else if (name.type === "aliased_import") {
          const module = name.childForFieldName("name")?.text ?? "";
          imports.push({
            local: name.childForFieldName("alias")?.text ?? module,
            imported: "*",
            from: module,
            line: line(node),
          });
        }
      }
    } else if (node.type === "import_from_statement") {
      // from a.b import c, d as e  /  from . import f  /  from x import *
      const moduleName = node.childForFieldName("module_name");
      const from = moduleName?.text ?? "";
      for (const name of node.children) {
        // Nodes are fresh objects on every access, so compare positions, not identity.
        if (!name || name.startIndex === moduleName?.startIndex) continue;
        if (name.type === "dotted_name")
          imports.push({ local: name.text, imported: name.text, from, line: line(node) });
        else if (name.type === "aliased_import") {
          const imported = name.childForFieldName("name")?.text ?? "";
          imports.push({ local: name.childForFieldName("alias")?.text ?? imported, imported, from, line: line(node) });
        } else if (name.type === "wildcard_import") imports.push({ local: "*", imported: "*", from, line: line(node) });
      }
    }
  }
  return { definitions, imports };
}

// ─── Go ──────────────────────────────────────────────────────────────────────────────────────────

const GO_REFERENCES = `
  (call_expression function: (identifier) @name)
  (call_expression function: (selector_expression operand: (_) @object field: (field_identifier) @name))
  (call_expression function: (index_expression operand: (identifier) @name))
  (call_expression function: (index_expression operand: (selector_expression operand: (_) @object field: (field_identifier) @name)))
  (type_conversion_expression type: (generic_type type: (type_identifier) @name))
  (type_conversion_expression type: (generic_type type: (qualified_type package: (package_identifier) @object name: (type_identifier) @name)))
  (composite_literal type: (type_identifier) @name)
  (composite_literal type: (qualified_type package: (package_identifier) @object name: (type_identifier) @name))
  (composite_literal type: (generic_type type: (type_identifier) @name))
  (composite_literal type: (generic_type type: (qualified_type package: (package_identifier) @object name: (type_identifier) @name)))
  (argument_list (identifier) @name)
  (argument_list (selector_expression operand: (_) @object field: (field_identifier) @name))
  (keyed_element value: (literal_element (identifier) @value))
  (keyed_element value: (literal_element (selector_expression operand: (_) @object field: (field_identifier) @value)))
  (literal_value (literal_element (identifier) @value))
  (literal_value (literal_element (selector_expression operand: (_) @object field: (field_identifier) @value)))
  (assignment_statement right: (expression_list (identifier) @value))
  (assignment_statement right: (expression_list (selector_expression operand: (_) @object field: (field_identifier) @value)))
  (short_var_declaration right: (expression_list (identifier) @value))
  (short_var_declaration right: (expression_list (selector_expression operand: (_) @object field: (field_identifier) @value)))
  (var_spec value: (expression_list (identifier) @value))
  (var_spec value: (expression_list (selector_expression operand: (_) @object field: (field_identifier) @value)))
  (return_statement (expression_list (identifier) @value))
  (return_statement (expression_list (selector_expression operand: (_) @object field: (field_identifier) @value)))
`;

/**
 * Names in value positions that are never a package's function: Go's predeclared identifiers and the locals almost
 * every function has. Dropping them keeps the index small; anything of two letters or fewer goes too.
 */
const GO_VALUE_NOISE = new Set(["err", "ctx", "nil", "true", "false", "iota", "ok", "res", "resp", "req", "result"]);

const isGoExported = (name: string) => /^\p{Lu}/u.test(name);

/**
 * The name a package is usually imported as, from its path: the last element, skipping a major-version suffix
 * (`.../foo/v2` is `foo`) and dropping `.vN` (`gopkg.in/yaml.v3` is `yaml`) and a `go-` prefix (`go-sqlite3`).
 */
export function goPackageNameFromPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  let last = parts.at(-1) ?? path;
  if (/^v\d+$/.test(last) && parts.length > 1) last = parts.at(-2) ?? last;
  return last
    .replace(/\.v\d+$/, "")
    .replace(/^go-/, "")
    .replace(/-go$/, "")
    .replace(/[^A-Za-z0-9_]/g, "_");
}

/** The type a method's receiver names, and its variable: `(s *Server)`, `(b Box[T])`, `(Server)`. */
function receiverOf(method: Node): { type?: string; name?: string } {
  const param = method.childForFieldName("receiver")?.namedChildren.find((c) => c?.type === "parameter_declaration");
  const name = param?.childForFieldName("name")?.text;
  let type = param?.childForFieldName("type") ?? null;
  while (type && type.type !== "type_identifier") {
    type =
      type.type === "pointer_type"
        ? type.namedChild(0)
        : type.type === "generic_type"
          ? type.childForFieldName("type")
          : null;
  }
  return { ...(type ? { type: type.text } : {}), ...(name ? { name } : {}) };
}

const collapse = (text: string) =>
  text
    .replace(/\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .replace(/\( /g, "(")
    .replace(/,? \)/g, ")")
    .trim();

/** A func's declaration up to its body: `func (s *Server) Handle(ctx context.Context) error`. */
function goSignature(node: Node): string {
  const body = node.childForFieldName("body");
  return collapse(body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text);
}

/**
 * What code using a type depends on. An interface's whole method set (adding a method breaks implementers); for any
 * other type, its underlying type. A struct counts as its name only: adding fields breaks nobody using keyed literals,
 * so field changes are left to the model rather than flagged as a changed signature.
 */
function goTypeSignature(spec: Node): string {
  const type = spec.childForFieldName("type");
  if (type?.type === "struct_type") {
    const params = spec.childForFieldName("type_parameters")?.text ?? "";
    return collapse(`type ${spec.childForFieldName("name")?.text}${params} struct`);
  }
  return collapse(`type ${spec.text}`);
}

/** An embedded type as written, without `*` or type arguments: `Inner`, `pkg.Inner`. */
function goTypeName(type: Node | null): string | undefined {
  while (type && (type.type === "pointer_type" || type.type === "generic_type")) {
    type = type.type === "pointer_type" ? type.namedChild(0) : type.childForFieldName("type");
  }
  return type?.type === "type_identifier" || type?.type === "qualified_type" ? type.text : undefined;
}

/**
 * What a struct or interface embeds, and an interface's own methods. A struct gets an embedded type's methods
 * (promoted), and so do interfaces embedding another; a type with all of an interface's methods implements it.
 */
function goMembers(type: Node | null): { bases?: string[]; methods?: string[] } {
  const bases: string[] = [];
  const methods: string[] = [];
  if (type?.type === "struct_type") {
    const list = type.namedChildren.find((c) => c?.type === "field_declaration_list");
    for (const field of list?.namedChildren ?? []) {
      // An embedded field has a type and no name.
      if (field?.type !== "field_declaration" || field.childForFieldName("name")) continue;
      const name = goTypeName(field.childForFieldName("type"));
      if (name) bases.push(name);
    }
  } else if (type?.type === "interface_type") {
    for (const member of type.namedChildren) {
      if (member?.type === "method_elem") {
        const name = member.childForFieldName("name")?.text;
        if (name) methods.push(name);
      } else if (member?.type === "type_elem" && member.namedChildCount === 1) {
        // `io.Reader` embeds an interface; `~int | ~string` is a constraint, not an embedding.
        const name = goTypeName(member.namedChild(0));
        if (name) bases.push(name);
      }
    }
  }
  return { ...(bases.length > 0 ? { bases } : {}), ...(methods.length > 0 ? { methods } : {}) };
}

function extractGo(root: Node): Omit<FileSymbols, "language" | "references"> {
  const definitions: Definition[] = [];
  const imports: ImportBinding[] = [];
  const add = (
    node: Node,
    name: string | undefined,
    kind: DefinitionKind,
    extra: { container?: string; receiver?: string; signature?: string; bases?: string[]; methods?: string[] } = {},
  ) => {
    if (!name || name === "_") return;
    const { container, receiver, signature, bases, methods } = extra;
    definitions.push({
      name,
      kind,
      exported: isGoExported(name),
      startLine: line(node),
      endLine: endLine(node),
      ...(container ? { container } : {}),
      ...(receiver && receiver !== "_" ? { receiver } : {}),
      ...(signature ? { signature } : {}),
      ...(bases ? { bases } : {}),
      ...(methods ? { methods } : {}),
    });
  };
  let goPackage: string | undefined;

  for (const node of root.namedChildren) {
    if (!node) continue;
    switch (node.type) {
      case "package_clause":
        goPackage = node.namedChild(0)?.text;
        break;
      case "import_declaration":
        for (const spec of node.descendantsOfType("import_spec")) {
          if (!spec) continue;
          const from = unquote(spec.childForFieldName("path")?.text ?? "");
          const alias = spec.childForFieldName("name");
          // `_` imports run init() only; `.` imports merge names in, which bare-name matching covers.
          if (!from || alias?.type === "blank_identifier" || alias?.type === "dot") continue;
          imports.push({
            local: alias?.text ?? goPackageNameFromPath(from),
            imported: "*",
            from,
            line: line(spec),
            ...(alias ? {} : { implicitName: true }),
          });
        }
        break;
      case "function_declaration":
        add(node, node.childForFieldName("name")?.text, "function", { signature: goSignature(node) });
        break;
      case "method_declaration": {
        const receiver = receiverOf(node);
        add(node, node.childForFieldName("name")?.text, "method", {
          ...(receiver.type ? { container: receiver.type } : {}),
          ...(receiver.name ? { receiver: receiver.name } : {}),
          signature: goSignature(node),
        });
        break;
      }
      case "type_declaration":
        for (const spec of node.namedChildren) {
          if (spec?.type !== "type_spec" && spec?.type !== "type_alias") continue;
          const type = spec.childForFieldName("type");
          const kind = type?.type === "struct_type" ? "class" : type?.type === "interface_type" ? "interface" : "type";
          // A grouped `type ( ... )` spans many specs; each gets its own lines.
          add(spec, spec.childForFieldName("name")?.text, kind, {
            signature: goTypeSignature(spec),
            ...goMembers(type),
          });
        }
        break;
      case "const_declaration":
      case "var_declaration":
        // Plain values only matter when exported, as in TypeScript. A package-level function variable
        // (`var now = func() time.Time {…}`, swapped out in tests) is called like a function, so it counts either way.
        for (const spec of node.descendantsOfType(["const_spec", "var_spec"])) {
          if (!spec) continue;
          const values = spec.childForFieldName("value")?.namedChildren ?? [];
          const isFunc = values.length === 1 && values[0]?.type === "func_literal";
          for (const name of spec.childrenForFieldName("name")) {
            if (name && (isGoExported(name.text) || isFunc)) add(spec, name.text, "variable");
          }
        }
        break;
    }
  }
  return { definitions, imports, ...(goPackage ? { goPackage } : {}) };
}

// ─── PHP ─────────────────────────────────────────────────────────────────────────────────────────

const PHP_REFERENCES = `
  (function_call_expression function: (name) @name)
  (function_call_expression function: (qualified_name (name) @name))
  (member_call_expression object: (_) @object name: (name) @name)
  (nullsafe_member_call_expression object: (_) @object name: (name) @name)
  (scoped_call_expression scope: (_) @object name: (name) @name)
  (object_creation_expression (name) @name)
  (object_creation_expression (qualified_name) @qualified)
  (class_constant_access_expression . (name) @object (name) @name)
  (class_constant_access_expression . (qualified_name) @qualified)
  (base_clause (name) @name)
  (base_clause (qualified_name) @qualified)
  (class_interface_clause (name) @name)
  (class_interface_clause (qualified_name) @qualified)
  (named_type (name) @name)
  (named_type (qualified_name) @qualified)
  (member_access_expression object: (_) @object name: (name) @name)
  (nullsafe_member_access_expression object: (_) @object name: (name) @name)
`;

/** What a PHP reference is, from where its name sits. */
function phpKind(node: Node): Reference["kind"] {
  const parent = node.parent;
  if (parent?.type === "object_creation_expression") return "new";
  if (parent?.type === "named_type") return "type";
  if (parent?.type === "member_access_expression" || parent?.type === "nullsafe_member_access_expression")
    return "property";
  return undefined;
}

// Type hints count as uses: in Laravel and Symfony, a class is mostly used by being injected (`__construct(Foo $foo)`).

/** "\\App\\Models\\User" → "App\\Models\\User"; relative names are joined to the file's namespace. */
function phpFqn(name: string, namespace: string | undefined): string {
  if (name.startsWith("\\")) return name.slice(1);
  return namespace ? `${namespace}\\${name}` : name;
}

const lastSegment = (name: string) => name.split("\\").at(-1) ?? name;

/** A declaration up to its body: `public function charge(User $user, int $cents): Receipt`. */
function phpSignature(node: Node): string {
  const body = node.childForFieldName("body");
  return collapse((body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text).replace(/;\s*$/, ""));
}

function extractPhp(root: Node): Omit<FileSymbols, "language" | "references"> {
  const definitions: Definition[] = [];
  const imports: ImportBinding[] = [];
  let namespace: string | undefined;

  const classLike = (node: Node) => {
    const name = node.childForFieldName("name")?.text;
    if (!name) return;
    // What it extends and implements, and the traits it uses (`use HasRelationships;` in the body).
    const traitUses = (node.childForFieldName("body")?.namedChildren ?? []).filter(
      (c) => c?.type === "use_declaration",
    );
    const bases = [
      ...node.namedChildren.filter((c) => c?.type === "base_clause" || c?.type === "class_interface_clause"),
      ...traitUses,
    ]
      .flatMap((c) => c?.namedChildren.filter((n) => n?.type === "name" || n?.type === "qualified_name") ?? [])
      .map((n) => n?.text ?? "")
      .filter(Boolean);
    // A facade names its target in getFacadeAccessor: `return Foo::class;`.
    const accessor = node
      .childForFieldName("body")
      ?.namedChildren.find(
        (m) => m?.type === "method_declaration" && m.childForFieldName("name")?.text === "getFacadeAccessor",
      );
    // Or, when it returns a container key ('download'), the Laravel convention of naming the target in the
    // docblock: `@see \App\Services\DownloadService`.
    const docblock = node.previousNamedSibling?.type === "comment" ? node.previousNamedSibling.text : "";
    const target = accessor
      ? (accessor.descendantsOfType("class_constant_access_expression").find((c) => c?.lastChild?.text === "class")
          ?.firstChild?.text ?? /@see\s+(\\?[A-Za-z_][\w\\]*)/.exec(docblock)?.[1])
      : undefined;
    definitions.push({
      name,
      kind: node.type === "interface_declaration" ? "interface" : "class",
      exported: true,
      startLine: line(node),
      endLine: endLine(node),
      signature: phpSignature(node),
      ...(bases.length > 0 ? { bases } : {}),
      ...(target ? { facadeFor: target } : {}),
    });
    for (const member of node.childForFieldName("body")?.namedChildren ?? []) {
      if (member?.type !== "method_declaration") continue;
      const method = member.childForFieldName("name")?.text;
      if (!method) continue;
      // No modifier means public; protected methods are the class family's business, like TypeScript's.
      const visibility = member.namedChildren.find((c) => c?.type === "visibility_modifier")?.text ?? "public";
      definitions.push({
        name: method,
        kind: "method",
        exported: visibility === "public",
        startLine: line(member),
        endLine: endLine(member),
        container: name,
        signature: phpSignature(member),
      });
    }
  };

  const visit = (node: Node) => {
    switch (node.type) {
      case "namespace_definition": {
        namespace = node.childForFieldName("name")?.text;
        // `namespace Foo { ... }` wraps its declarations.
        const body = node.childForFieldName("body");
        if (body) for (const child of body.namedChildren) if (child) visit(child);
        break;
      }
      case "namespace_use_declaration": {
        // `use function` and `use const` import functions and constants, which PSR-4 can't place in a file.
        if (/^use\s+(function|const)\b/i.test(node.text)) break;
        const group = node.childForFieldName("body");
        const prefix = group ? node.namedChildren.find((c) => c?.type === "namespace_name")?.text : undefined;
        const clauses = (group ?? node).namedChildren.filter((c) => c?.type === "namespace_use_clause");
        for (const clause of clauses) {
          if (!clause) continue;
          const target = clause.namedChildren.find((c) => c?.type === "qualified_name" || c?.type === "name");
          if (!target) continue;
          const fqn = (prefix ? `${prefix}\\${target.text}` : target.text).replace(/^\\/, "");
          const alias = clause.childForFieldName("alias")?.text;
          imports.push({ local: alias ?? lastSegment(fqn), imported: lastSegment(fqn), from: fqn, line: line(node) });
        }
        break;
      }
      case "class_declaration":
      case "interface_declaration":
      case "trait_declaration":
      case "enum_declaration":
        classLike(node);
        break;
      case "function_definition": {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          definitions.push({
            name,
            kind: "function",
            exported: true,
            startLine: line(node),
            endLine: endLine(node),
            signature: phpSignature(node),
          });
        }
        break;
      }
    }
  };
  for (const node of root.namedChildren) if (node) visit(node);
  return { definitions, imports, ...(namespace ? { phpNamespace: namespace } : {}) };
}

// ─── Ruby ────────────────────────────────────────────────────────────────────────────────────────

/** Calls that enqueue a job: `SyncJob.perform_later(x)` runs `SyncJob#perform` (ActiveJob, Sidekiq). */
const RUBY_ENQUEUE = new Set([
  "perform_later",
  "perform_now",
  "perform_async",
  "perform_in",
  "perform_at",
  "perform_inline",
  "perform_bulk",
]);

/** Calls that call the method a symbol names: `send(:x)`, `record.try(:x)`, `method(:x)`. */
const RUBY_DYNAMIC = new Set(["send", "public_send", "__send__", "try", "try!", "method", "public_method"]);

/**
 * Class-body macros whose symbols aren't methods of the class: associations, attributes and the like. Everything else
 * (`before_action :x`, `validate :x`, `after_commit :x, if: :y`, `delegate … to: :x`) names methods it calls.
 */
const RUBY_SYMBOL_MACROS_SKIP = new Set([
  "has_many",
  "has_one",
  "belongs_to",
  "has_and_belongs_to_many",
  "attr_accessor",
  "attr_reader",
  "attr_writer",
  "attribute",
  "attr_encrypted",
  "encrypts",
  "store_accessor",
  "enum",
  "scope",
  "include",
  "extend",
  "prepend",
  "require",
  "require_relative",
  "private",
  "protected",
  "public",
  "private_class_method",
  "public_class_method",
  "module_function",
  "private_constant",
  "alias_method",
  "define_method",
  "validates",
  "validates_presence_of",
  "accepts_nested_attributes_for",
  "has_one_attached",
  "has_many_attached",
  "has_rich_text",
  "monetize",
  "serialize",
  "normalizes",
  "broadcasts",
  "queue_as",
  "rescue_from",
  "retry_on",
  "discard_on",
]);

/** Options of a class-body macro whose symbol names a method: `if: :ready?`, `delegate … to: :account`. */
const RUBY_METHOD_OPTIONS = new Set(["if", "unless", "to", "with", "method"]);

/** Ruby's `Rule::Runner` or `Runner`: the constant's own name, which is what the graph keys classes by. */
const rubyConstant = (node: Node): string | undefined =>
  node.type === "constant"
    ? node.text
    : node.type === "scope_resolution"
      ? node.childForFieldName("name")?.text
      : undefined;

/** Ruby's `::Rule::Runner` as written, without the leading `::`, for constants and constant paths. */
const rubyConstantPath = (node: Node): string | undefined =>
  node.type === "constant" || node.type === "scope_resolution" ? node.text.replace(/^::/, "") : undefined;

/** The namespace a constant was written with, as a reference's `qualified`. */
const rubyQualified = (node: Node | null): { qualified?: string } => {
  const path = node?.type === "scope_resolution" ? rubyConstantPath(node) : undefined;
  return path ? { qualified: path } : {};
};

/** A receiver as text: constants by their own name, short expressions as written, long ones by their last call. */
function rubyObject(node: Node): string {
  const constant = rubyConstant(node);
  if (constant) return constant;
  // `SyncJob.set(wait: 5.minutes).perform_later`: the job class is the receiver that matters.
  if (node.type === "call" && node.childForFieldName("method")?.text === "set") {
    const receiver = node.childForFieldName("receiver");
    if (receiver) return rubyObject(receiver);
  }
  const text = node.text;
  if (!text.includes("\n") && text.length <= 60) return text;
  return node.type === "call" ? (node.childForFieldName("method")?.text ?? "") : node.type;
}

/** Whether a node sits in a class or module body rather than inside a method (where `before_action` can be called). */
function inRubyClassBody(node: Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "method" || p.type === "singleton_method" || p.type === "lambda") return false;
    if (p.type === "class" || p.type === "module" || p.type === "singleton_class") return true;
  }
  return false;
}

const RUBY_PARAMETER_NODES = new Set([
  "method_parameters",
  "block_parameters",
  "lambda_parameters",
  "optional_parameter",
  "keyword_parameter",
  "splat_parameter",
  "hash_splat_parameter",
  "block_parameter",
  "destructured_parameter",
]);

/** Whether `id` is the parameter's own name, not part of its default value (`scope: matching_scope`). */
function rubyParameterName(param: Node, id: Node): boolean {
  const name = param.childForFieldName("name");
  return name ? name.startIndex === id.startIndex : true;
}

/**
 * The local variables a method (or the file's top level) has: parameters, block parameters and assigned names. A bare
 * identifier that isn't one of these is a call to a method without parentheses (`matching_scope`, `current_user`).
 */
function rubyLocals(scope: Node): Set<string> {
  const locals = new Set<string>();
  for (const id of scope.descendantsOfType("identifier")) {
    if (!id) continue;
    const parent = id.parent;
    if (!parent) continue;
    const isLeft =
      ((parent.type === "assignment" || parent.type === "operator_assignment") &&
        parent.childForFieldName("left")?.startIndex === id.startIndex) ||
      parent.type === "left_assignment_list" ||
      parent.type === "rest_assignment" ||
      (parent.type === "for" && parent.childForFieldName("pattern")?.startIndex === id.startIndex) ||
      (RUBY_PARAMETER_NODES.has(parent.type) && rubyParameterName(parent, id)) ||
      parent.type === "exception_variable";
    if (isLeft) locals.add(id.text);
  }
  return locals;
}

/** Positions where an identifier isn't a use: names of definitions, keys, the method part of a call. */
function rubyIdentifierIsUse(id: Node): boolean {
  const parent = id.parent;
  if (!parent) return false;
  if (RUBY_PARAMETER_NODES.has(parent.type) && rubyParameterName(parent, id)) return false;
  if (parent.type === "alias") return false;
  if (
    (parent.type === "method" || parent.type === "singleton_method") &&
    parent.childForFieldName("body")?.startIndex !== id.startIndex
  )
    return false;
  if (parent.type === "call") return false; // the method (handled as a call) or the receiver (a local or a call)
  if (parent.type === "pair" && parent.childForFieldName("key")?.startIndex === id.startIndex) return false;
  if (parent.type === "left_assignment_list" || parent.type === "rest_assignment") return false;
  if (
    (parent.type === "assignment" || parent.type === "operator_assignment") &&
    parent.childForFieldName("left")?.startIndex === id.startIndex
  )
    return false;
  if (parent.type === "exception_variable" || parent.type === "for") return false;
  return true;
}

function rubyReferences(root: Node): Reference[] {
  const references: Reference[] = [];
  const push = (name: string | undefined, node: Node, extra: Omit<Reference, "name" | "line"> = {}) => {
    if (name) references.push({ name, line: line(node), ...extra });
  };
  const symbolName = (node: Node | null) => (node?.type === "simple_symbol" ? node.text.slice(1) : undefined);

  for (const call of root.descendantsOfType("call")) {
    if (!call) continue;
    const method = call.childForFieldName("method");
    if (!method || (method.type !== "identifier" && method.type !== "constant")) continue;
    const name = method.text;
    const receiver = call.childForFieldName("receiver");
    const object = receiver ? rubyObject(receiver) : undefined;
    const args = call.childForFieldName("arguments");
    const firstArg = args?.namedChild(0) ?? null;

    if (name === "new" && receiver && rubyConstant(receiver)) {
      push(rubyConstant(receiver), method, { kind: "new", ...rubyQualified(receiver) });
    } else if (RUBY_ENQUEUE.has(name)) {
      push("perform", method, object ? { object } : {});
    } else if (RUBY_DYNAMIC.has(name) && symbolName(firstArg)) {
      push(symbolName(firstArg), firstArg ?? method, object ? { object } : {});
    } else if (RSPEC_RECEIVE.has(name) && !receiver && symbolName(firstArg) && symbolName(firstArg) !== "new") {
      // `expect(service).to have_received(:call)`: a spec stubbing or checking a call on `service`.
      const target = rspecTarget(call);
      push(symbolName(firstArg), firstArg ?? method, target ? { object: target } : {});
    } else {
      // `Rule::Runner.new.call`: the class written in front of `new` (or `find`, …) is the receiver's.
      const written = receiver?.type === "call" ? receiver.childForFieldName("receiver") : receiver;
      push(name, method, object ? { object, ...rubyQualified(written ?? null) } : {});
    }

    // `before_action :set_entry, if: :ready?` in a class body names the methods it will call.
    if (!receiver && args && !RUBY_SYMBOL_MACROS_SKIP.has(name) && inRubyClassBody(call)) {
      for (const arg of args.namedChildren) {
        if (!arg) continue;
        // `only: :update` names an action, not a method the macro calls.
        if (arg.type === "pair" && !RUBY_METHOD_OPTIONS.has(arg.childForFieldName("key")?.text.replace(/:$/, "") ?? ""))
          continue;
        const value = arg.type === "pair" ? arg.childForFieldName("value") : arg;
        push(symbolName(value), value ?? arg, { kind: "value" });
      }
    }
  }

  // Constants used anywhere other than as a call's receiver (handled above) or a definition's name.
  for (const constant of root.descendantsOfType("constant")) {
    if (!constant) continue;
    const parent = constant.parent;
    if (parent?.type === "class" || parent?.type === "module") continue;
    if (parent?.type === "scope_resolution") {
      // Only the last part of `A::B::C` is the class; `A::B` is its namespace.
      if (parent.childForFieldName("name")?.startIndex !== constant.startIndex) continue;
      const holder = parent.parent;
      if (holder?.type === "class" || holder?.type === "module") continue;
      if (holder?.type === "call" && holder.childForFieldName("receiver")?.startIndex === parent.startIndex) continue;
    }
    if (parent?.type === "call") continue;
    push(constant.text, constant, {
      kind: "type",
      ...rubyQualified(parent?.type === "scope_resolution" ? parent : null),
    });
  }

  // Methods called without parentheses or arguments: a bare name that isn't a local variable.
  const scopes = [root, ...root.descendantsOfType(["method", "singleton_method"]).filter((n) => n !== null)];
  for (const scope of scopes) {
    const locals = rubyLocals(scope);
    for (const id of scope.descendantsOfType("identifier")) {
      if (!id || id.text.length <= 2 || locals.has(id.text) || !rubyIdentifierIsUse(id)) continue;
      // Each identifier once: the innermost method that holds it.
      let owner: Node | null = id.parent;
      while (owner && owner.type !== "method" && owner.type !== "singleton_method") owner = owner.parent;
      if ((owner?.startIndex ?? root.startIndex) !== scope.startIndex) continue;
      push(id.text, id);
    }
  }
  return rspecDescribed(root, rubyTyped(root, references));
}

const RSPEC_RECEIVE = new Set(["receive", "have_received"]);
const RSPEC_TARGETS = new Set(["expect", "allow", "expect_any_instance_of", "allow_any_instance_of"]);

/** The object in `expect(x).to …` around a matcher, as a receiver: `Foo.new` for `allow_any_instance_of(Foo)`. */
function rspecTarget(matcher: Node): string | undefined {
  let node: Node | null = matcher.parent;
  while (node && !(node.type === "call" && /^(to|not_to|to_not)$/.test(node.childForFieldName("method")?.text ?? "")))
    node = node.parent;
  const expectation = node?.childForFieldName("receiver");
  const method = expectation?.childForFieldName("method")?.text ?? "";
  const subject = expectation?.childForFieldName("arguments")?.namedChild(0);
  if (!subject || !RSPEC_TARGETS.has(method)) return undefined;
  return method.endsWith("any_instance_of") ? `${subject.text}.new` : rubyObject(subject);
}

/** `Foo.new`, `instance_double(Foo)`: the class a value is an instance of, as written. */
function rubyInstanceOf(value: Node | null | undefined): string | undefined {
  if (value?.type !== "call") return undefined;
  const method = value.childForFieldName("method")?.text;
  const receiver = value.childForFieldName("receiver");
  if (method === "new" && receiver)
    return receiver.text === "described_class" ? "described_class" : rubyConstantPath(receiver);
  if (receiver || (method !== "instance_double" && method !== "instance_spy")) return undefined;
  const first = value.childForFieldName("arguments")?.namedChild(0);
  if (!first) return undefined;
  return rubyConstantPath(first) ?? (first.type === "string" ? unquote(first.text).replace(/^::/, "") : undefined);
}

const RUBY_SCOPES = new Set(["method", "singleton_method", "do_block", "block", "class", "module"]);

/**
 * Variables holding an instance of a known class: `client = Api::Client.new`, `@client = …`, RSpec's
 * `let(:service) { instance_double(VerifyQuoteService) }` and `allow(Foo).to receive(:new).and_return(service)`.
 * Calls on them become calls on `Class.new`, which is how the graph reads an instance of the class.
 */
function rubyTyped(root: Node, references: Reference[]): Reference[] {
  const variables: { name: string; written: string; start: number; end: number }[] = [];
  const scopeOf = (node: Node, kinds: Set<string>) => {
    let scope: Node | null = node.parent;
    while (scope && !kinds.has(scope.type)) scope = scope.parent;
    return scope ?? root;
  };
  const add = (name: string, written: string | undefined, scope: Node) => {
    if (written) variables.push({ name, written, start: line(scope), end: endLine(scope) });
  };
  for (const assignment of root.descendantsOfType("assignment")) {
    const left = assignment?.childForFieldName("left");
    if (!assignment || (left?.type !== "identifier" && left?.type !== "instance_variable")) continue;
    const kinds = left.type === "instance_variable" ? new Set(["class", "module"]) : RUBY_SCOPES;
    add(left.text, rubyInstanceOf(assignment.childForFieldName("right")), scopeOf(assignment, kinds));
  }
  for (const call of root.descendantsOfType("call")) {
    const method = call?.childForFieldName("method")?.text;
    if (!call || !method) continue;
    const first = call.childForFieldName("arguments")?.namedChild(0);
    if (/^(let!?|subject)$/.test(method) && first?.type === "simple_symbol" && !call.childForFieldName("receiver")) {
      const body = call.childForFieldName("block")?.childForFieldName("body");
      const last = body?.namedChildren.filter((c): c is Node => c !== null).at(-1);
      add(first.text.slice(1), rubyInstanceOf(last), scopeOf(call, RUBY_SCOPES));
    } else if (method === "and_return" && first?.type === "identifier") {
      const stub = call.childForFieldName("receiver");
      const target = stub?.childForFieldName("method")?.text === "receive" ? rspecTarget(stub) : undefined;
      if (target && stub?.childForFieldName("arguments")?.namedChild(0)?.text === ":new") add(first.text, target, root);
    }
  }
  if (variables.length === 0) return references;
  return references.map((ref) => {
    const found = variables
      .filter((v) => v.name === ref.object && v.start <= ref.line && ref.line <= v.end)
      .sort((a, b) => b.start - a.start)[0];
    if (!found) return ref;
    const short = found.written.split("::").at(-1) ?? found.written;
    return { ...ref, object: `${short}.new`, ...(found.written.includes("::") ? { qualified: found.written } : {}) };
  });
}

/**
 * RSpec: in `RSpec.describe Rule::Runner do`, `described_class` and `subject` stand for Rule::Runner, which is how
 * specs mostly call the code they test (`described_class.new(rule).call`, `subject.perform`).
 */
function rspecDescribed(root: Node, references: Reference[]): Reference[] {
  let described: string | undefined;
  for (const node of root.namedChildren) {
    if (node?.type !== "call" || node.childForFieldName("method")?.text !== "describe") continue;
    const receiver = node.childForFieldName("receiver")?.text;
    if (receiver !== undefined && receiver !== "RSpec") continue;
    const first = node.childForFieldName("arguments")?.namedChild(0);
    described = first ? rubyConstantPath(first) : undefined;
    if (described) break;
  }
  if (!described) return references;
  const short = described.split("::").at(-1) ?? described;
  const qualified = described.includes("::") ? { qualified: described } : {};
  return references.map((ref) => {
    const object = ref.object?.replace(/\.new(\(.*\))?$/, "");
    if (object !== "described_class" && object !== "subject") return ref;
    if (ref.name === "new" && ref.object === "described_class")
      return { name: short, line: ref.line, kind: "new", ...qualified };
    return { ...ref, object: ref.object === object ? short : `${short}.new`, ...qualified };
  });
}

/** `def self.charge(user, amount:, currency: "EUR")`: what callers depend on, without the body. */
function rubySignature(node: Node): string {
  const name = node.childForFieldName("name")?.text ?? "";
  const params = node.childForFieldName("parameters")?.text ?? "";
  const self = node.type === "singleton_method" ? "self." : "";
  // `def helper` and `def helper()` are the same method; the parentheses make adding a parameter comparable.
  const list = params.startsWith("(") ? params : `(${params})`;
  return collapse(`def ${self}${name}${list}`);
}

function extractRuby(root: Node): Omit<FileSymbols, "language"> {
  const definitions: Definition[] = [];

  const method = (node: Node, container: string | undefined, exported: boolean) => {
    const name = node.childForFieldName("name")?.text;
    if (!name) return;
    definitions.push({
      name,
      kind: container ? "method" : "function",
      exported,
      startLine: line(node),
      endLine: endLine(node),
      ...(container ? { container } : {}),
      signature: rubySignature(node),
    });
  };

  /**
   * A class or module body, or a block inside one (`included do`, `class_methods do`). `namespace` is the body's full
   * constant path. A module's private methods are still for the classes including it to call.
   */
  const body = (node: Node | null, container: string, namespace: string, classMethods = false, mixin = false) => {
    if (!node) return;
    let visibility = "public";
    const hidden = new Set<string>();
    const start = definitions.length;
    for (const child of node.namedChildren) {
      if (!child) continue;
      switch (child.type) {
        case "identifier":
          // A bare `private` makes the methods after it private.
          if (/^(private|protected|public)$/.test(child.text)) visibility = child.text;
          break;
        case "method":
          method(child, container, visibility === "public" || classMethods || mixin);
          break;
        case "singleton_method":
          method(child, container, true);
          break;
        case "singleton_class":
          // class << self … end: class methods, public unless marked otherwise inside.
          body(child.childForFieldName("body"), container, namespace, true, mixin);
          break;
        case "class":
        case "module":
          classLike(child, namespace);
          break;
        case "assignment": {
          // `COLUMNS = %w[…].freeze`: its own definition, so changing it doesn't count as changing the whole class.
          const left = child.childForFieldName("left");
          if (left?.type === "constant") {
            definitions.push({
              name: left.text,
              kind: "variable",
              exported: true,
              startLine: line(child),
              endLine: endLine(child),
              container,
            });
          }
          break;
        }
        case "call": {
          const name = child.childForFieldName("method")?.text ?? "";
          const args = child.childForFieldName("arguments")?.namedChildren ?? [];
          if (child.childForFieldName("receiver")) break;
          if (/^(private|protected|public|private_class_method)$/.test(name)) {
            for (const arg of args) {
              if (arg?.type === "method" || arg?.type === "singleton_method")
                method(arg, container, name === "public" || mixin);
              else if (arg?.type === "simple_symbol" && name !== "public" && !mixin) hidden.add(arg.text.slice(1));
            }
          } else if (name === "scope" && args[0]?.type === "simple_symbol") {
            // `scope :active, -> { … }` defines `Model.active`.
            definitions.push({
              name: args[0].text.slice(1),
              kind: "method",
              exported: true,
              startLine: line(child),
              endLine: endLine(child),
              container,
              signature: collapse(child.text.split("->")[0]?.replace(/,\s*$/, "") ?? child.text),
            });
          } else {
            // `included do`, `class_methods do`, `concerning :X do`: their defs belong to the class.
            const block = child.childForFieldName("block");
            if (block) body(block.childForFieldName("body"), container, namespace, classMethods, mixin);
          }
          break;
        }
      }
    }
    for (const def of definitions.slice(start)) if (hidden.has(def.name)) def.exported = false;
  };

  const classLike = (node: Node, outer?: string) => {
    const nameNode = node.childForFieldName("name");
    const name = nameNode ? rubyConstant(nameNode) : undefined;
    const written = nameNode ? rubyConstantPath(nameNode) : undefined;
    if (!name || !written) return;
    const qualified = outer ? `${outer}::${written}` : written;
    const superclass = node.childForFieldName("superclass")?.namedChild(0);
    const bases: string[] = [];
    // As written (`Provider::Base`): the graph resolves it from this class's namespace, as Ruby does.
    const parent = superclass ? rubyConstantPath(superclass) : undefined;
    if (parent) bases.push(parent);
    // Modules it mixes in: `include Transferable`, `extend Monetizable`.
    for (const child of node.childForFieldName("body")?.namedChildren ?? []) {
      if (child?.type !== "call" || child.childForFieldName("receiver")) continue;
      if (!/^(include|extend|prepend)$/.test(child.childForFieldName("method")?.text ?? "")) continue;
      for (const arg of child.childForFieldName("arguments")?.namedChildren ?? []) {
        const mixin = arg ? rubyConstantPath(arg) : undefined;
        if (mixin) bases.push(mixin);
      }
    }
    definitions.push({
      name,
      kind: "class",
      exported: true,
      startLine: line(node),
      endLine: endLine(node),
      signature: collapse(`${node.type} ${nameNode?.text ?? name}${parent ? ` < ${superclass?.text}` : ""}`),
      ...(bases.length > 0 ? { bases } : {}),
      ...(qualified !== name ? { qualified } : {}),
    });
    body(node.childForFieldName("body"), name, qualified, false, node.type === "module");
  };

  for (const node of root.namedChildren) {
    if (!node) continue;
    if (node.type === "class" || node.type === "module") classLike(node);
    else if (node.type === "method") method(node, undefined, true);
  }
  return { definitions, imports: [], references: rubyReferences(root) };
}

// ─── Swift, Java and Kotlin ──────────────────────────────────────────────────────────────────────

/** A declaration up to its body, without attributes or annotations: `public func fetch(id: Int) -> String`. */
function headSignature(node: Node, bodyTypes: string[]): string {
  const body = node.namedChildren.find((c) => c !== null && bodyTypes.includes(c.type));
  const head = body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text;
  return collapse(head.replace(/@[\w.]+(\([^)]*\))?\s*/g, "").replace(/[;{]\s*$/, ""));
}

/** The last name in a type as written: `Base`, `Foo.Bar`, `Other<String>`, `com.acme.Base`. */
function lastTypeName(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  const text = node.text.replace(/<[\s\S]*$/, "").replace(/\?$/, "");
  return text.split(".").at(-1)?.trim() || undefined;
}

const SWIFT_REFERENCES = `
  (call_expression (simple_identifier) @name)
  (call_expression (navigation_expression target: (_) @object suffix: (navigation_suffix suffix: (simple_identifier) @name)))
  (value_argument value: (simple_identifier) @name)
  (user_type (type_identifier) @type)
  (call_expression (prefix_expression target: (simple_identifier) @implicit))
`;

function swiftVisibility(node: Node): string | undefined {
  const modifiers = node.namedChildren.find((c) => c?.type === "modifiers");
  return modifiers?.namedChildren.find((c) => c?.type === "visibility_modifier")?.text;
}

const swiftHidden = (node: Node) => /^(private|fileprivate)/.test(swiftVisibility(node) ?? "");

function extractSwift(root: Node): Omit<FileSymbols, "language" | "references"> {
  const definitions: Definition[] = [];
  const signatureOf = (node: Node) =>
    headSignature(node, ["function_body", "class_body", "protocol_body", "enum_class_body"]);

  const typeLike = (node: Node, outerHidden: boolean) => {
    const nameNode = node.childForFieldName("name");
    const name = lastTypeName(nameNode);
    if (!name) return;
    const hidden = outerHidden || swiftHidden(node);
    const bases = node.namedChildren
      .filter((c) => c?.type === "inheritance_specifier")
      .map((c) => lastTypeName(c?.childForFieldName("inherits_from")))
      .filter((b): b is string => Boolean(b));
    const isProtocol = node.type === "protocol_declaration";
    const methods: string[] = [];
    const body = node.childForFieldName("body");
    for (const member of body?.namedChildren ?? []) {
      if (!member) continue;
      if (member.type === "class_declaration" || member.type === "protocol_declaration") {
        typeLike(member, hidden);
        continue;
      }
      if (member.type === "property_declaration" || member.type === "protocol_property_declaration") {
        // Stored and computed properties are their own definitions, so editing one isn't editing the whole type.
        const property = member.descendantsOfType("simple_identifier").find((n) => n?.parent?.type === "pattern");
        if (property) {
          definitions.push({
            name: property.text,
            kind: "variable",
            exported: !hidden && !swiftHidden(member),
            startLine: line(member),
            endLine: endLine(member),
            container: name,
          });
        }
        continue;
      }
      const isInit = member.type === "init_declaration";
      if (member.type !== "function_declaration" && member.type !== "protocol_function_declaration" && !isInit)
        continue;
      const method = isInit ? "init" : member.childForFieldName("name")?.text;
      if (!method) continue;
      if (isProtocol) methods.push(method);
      definitions.push({
        name: method,
        kind: "method",
        exported: !hidden && !swiftHidden(member),
        startLine: line(member),
        endLine: endLine(member),
        container: name,
        signature: signatureOf(member),
      });
    }
    definitions.push({
      name,
      kind: isProtocol ? "interface" : "class",
      exported: !hidden,
      startLine: line(node),
      endLine: endLine(node),
      signature: signatureOf(node),
      ...(bases.length > 0 ? { bases } : {}),
      ...(methods.length > 0 ? { methods } : {}),
    });
  };

  for (const node of root.namedChildren) {
    if (!node) continue;
    if (node.type === "class_declaration" || node.type === "protocol_declaration") typeLike(node, false);
    else if (node.type === "function_declaration") {
      const name = node.childForFieldName("name")?.text;
      if (!name) continue;
      definitions.push({
        name,
        kind: "function",
        exported: !swiftHidden(node),
        startLine: line(node),
        endLine: endLine(node),
        signature: signatureOf(node),
      });
    }
  }
  return { definitions, imports: [] };
}

const JAVA_REFERENCES = `
  (method_invocation object: (_) @object name: (identifier) @name)
  (method_invocation !object name: (identifier) @name)
  (object_creation_expression type: (type_identifier) @name)
  (object_creation_expression type: (generic_type (type_identifier) @name))
  (method_reference (_) @object (identifier) @name)
  (field_access object: (identifier) @type)
  (type_identifier) @type
`;

const javaHidden = (node: Node) =>
  /\bprivate\b/.test(node.namedChildren.find((c) => c?.type === "modifiers")?.text ?? "");

/** An import as written: `com.acme.Foo`, `com.acme.*`, `static com.acme.Strings.join`. */
function jvmImport(path: string, alias: string | undefined, line_: number, wildcard: boolean, isStatic: boolean) {
  const parts = path.split(".");
  if (wildcard) return { local: "*", imported: "*", from: path, line: line_ };
  // A static import brings in a member by name (`import static pkg.Util.helper`), which the graph binds to its class.
  const name = parts.at(-1) ?? path;
  return { local: isStatic ? name : (alias ?? name), imported: name, from: path, line: line_ };
}

function extractJava(root: Node): Omit<FileSymbols, "language" | "references"> {
  const definitions: Definition[] = [];
  const imports: ImportBinding[] = [];
  let jvmPackage: string | undefined;
  const signatureOf = (node: Node) =>
    headSignature(node, ["block", "constructor_body", "class_body", "interface_body", "enum_body"]);

  const typeLike = (node: Node, outerHidden: boolean, outer?: string) => {
    const name = node.childForFieldName("name")?.text;
    if (!name) return;
    const qualified = outer ? `${outer}.${name}` : name;
    const hidden = outerHidden || javaHidden(node);
    const bases: string[] = [];
    const superclass = node.childForFieldName("superclass")?.namedChild(0);
    const parent = lastTypeName(superclass);
    if (parent) bases.push(parent);
    const lists = [
      node.childForFieldName("interfaces"),
      node.namedChildren.find((c) => c?.type === "extends_interfaces"),
    ];
    for (const list of lists) {
      for (const type of list?.namedChildren.find((c) => c?.type === "type_list")?.namedChildren ?? []) {
        const base = lastTypeName(type);
        if (base) bases.push(base);
      }
    }
    const isInterface = node.type === "interface_declaration" || node.type === "annotation_type_declaration";
    const methods: string[] = [];
    const body = node.childForFieldName("body");
    const members = [
      ...(body?.namedChildren ?? []),
      // An enum's methods sit after its constants.
      ...(body?.namedChildren.find((c) => c?.type === "enum_body_declarations")?.namedChildren ?? []),
    ];
    for (const member of members) {
      if (!member) continue;
      if (/^(class|interface|enum|record|annotation_type)_declaration$/.test(member.type)) {
        typeLike(member, hidden, qualified);
        continue;
      }
      if (member.type === "field_declaration" || member.type === "constant_declaration") {
        // Fields are their own definitions, so changing one isn't changing the whole class.
        for (const declarator of member.childrenForFieldName("declarator")) {
          const field = declarator?.childForFieldName("name")?.text;
          if (!field) continue;
          definitions.push({
            name: field,
            kind: "variable",
            exported: !hidden && !javaHidden(member),
            startLine: line(member),
            endLine: endLine(member),
            container: name,
          });
        }
        continue;
      }
      if (member.type !== "method_declaration" && member.type !== "constructor_declaration") continue;
      const method = member.childForFieldName("name")?.text;
      if (!method) continue;
      if (isInterface) methods.push(method);
      definitions.push({
        name: method,
        kind: "method",
        exported: !hidden && !javaHidden(member),
        startLine: line(member),
        endLine: endLine(member),
        container: name,
        signature: signatureOf(member),
      });
    }
    definitions.push({
      name,
      kind: isInterface ? "interface" : "class",
      exported: !hidden,
      startLine: line(node),
      endLine: endLine(node),
      signature: signatureOf(node),
      ...(bases.length > 0 ? { bases } : {}),
      ...(methods.length > 0 ? { methods } : {}),
      ...(outer ? { qualified } : {}),
    });
  };

  for (const node of root.namedChildren) {
    if (!node) continue;
    if (node.type === "package_declaration") jvmPackage = node.namedChild(0)?.text;
    else if (node.type === "import_declaration") {
      const path = node.namedChildren.find((c) => c?.type === "scoped_identifier" || c?.type === "identifier")?.text;
      if (!path) continue;
      const wildcard = node.namedChildren.some((c) => c?.type === "asterisk");
      imports.push(jvmImport(path, undefined, line(node), wildcard, /^import\s+static\b/.test(node.text)));
    } else if (/^(class|interface|enum|record|annotation_type)_declaration$/.test(node.type)) typeLike(node, false);
  }
  return { definitions, imports, ...(jvmPackage ? { jvmPackage } : {}) };
}

const KOTLIN_REFERENCES = `
  (call_expression (identifier) @name)
  (call_expression (navigation_expression (_) @object (identifier) @name .))
  (callable_reference (identifier) @name)
  (user_type (identifier) @type)
`;

function kotlinVisibility(node: Node): string {
  const modifiers = node.namedChildren.find((c) => c?.type === "modifiers");
  return modifiers?.namedChildren.find((c) => c?.type === "visibility_modifier")?.text ?? "public";
}

// `internal` is visible in the whole module, which is the repo as far as Alden can tell.
const kotlinHidden = (node: Node) => /^(private|protected)$/.test(kotlinVisibility(node));

function extractKotlin(root: Node): Omit<FileSymbols, "language" | "references"> {
  const definitions: Definition[] = [];
  const imports: ImportBinding[] = [];
  let jvmPackage: string | undefined;
  const signatureOf = (node: Node) => headSignature(node, ["function_body", "class_body", "enum_class_body"]);

  const fn = (node: Node, container: string | undefined, hidden: boolean) => {
    const name = node.childForFieldName("name")?.text;
    if (!name) return;
    // `fun Runner.ext()`: an extension function is called like a method of its receiver type.
    const nameStart = node.childForFieldName("name")?.startIndex ?? 0;
    const receiver = node.namedChildren.find(
      (c) => c !== null && (c.type === "user_type" || c.type === "nullable_type") && c.startIndex < nameStart,
    );
    const owner = container ?? lastTypeName(receiver);
    definitions.push({
      name,
      kind: owner ? "method" : "function",
      exported: !hidden && !kotlinHidden(node),
      startLine: line(node),
      endLine: endLine(node),
      ...(owner ? { container: owner } : {}),
      ...(!container && owner ? { extension: true } : {}),
      signature: signatureOf(node),
    });
  };

  const typeLike = (node: Node, outerHidden: boolean, outer?: string) => {
    const name = node.childForFieldName("name")?.text;
    if (!name) return;
    const qualified = outer ? `${outer}.${name}` : name;
    const hidden = outerHidden || kotlinHidden(node);
    const bases = (node.namedChildren.find((c) => c?.type === "delegation_specifiers")?.namedChildren ?? [])
      .map((spec) => {
        const type = spec?.namedChildren.find((c) => c?.type === "user_type" || c?.type === "constructor_invocation");
        return lastTypeName(type?.type === "constructor_invocation" ? type.namedChild(0) : type);
      })
      .filter((b): b is string => Boolean(b));
    const isInterface = node.children.some((c) => c?.type === "interface");
    const methods: string[] = [];
    const members = (bodyNode: Node | null | undefined) => {
      for (const member of bodyNode?.namedChildren ?? []) {
        if (!member) continue;
        if (member.type === "function_declaration") {
          fn(member, name, hidden);
          if (isInterface) methods.push(member.childForFieldName("name")?.text ?? "");
        } else if (member.type === "secondary_constructor") {
          definitions.push({
            name: "constructor",
            kind: "method",
            exported: !hidden && !kotlinHidden(member),
            startLine: line(member),
            endLine: endLine(member),
            container: name,
            signature: collapse(member.text.replace(/\{[\s\S]*$/, "")),
          });
        } else if (member.type === "property_declaration") {
          // Properties are their own definitions, so changing one isn't changing the whole class.
          const property = member.descendantsOfType("variable_declaration")[0]?.namedChild(0)?.text;
          if (property) {
            definitions.push({
              name: property,
              kind: "variable",
              exported: !hidden && !kotlinHidden(member),
              startLine: line(member),
              endLine: endLine(member),
              container: name,
            });
          }
        } else if (member.type === "companion_object") {
          // A companion's functions are called on the class: `Runner.make()`.
          members(member.namedChildren.find((c) => c?.type === "class_body"));
        } else if (member.type === "class_declaration" || member.type === "object_declaration") {
          typeLike(member, hidden, qualified);
        }
      }
    };
    members(node.namedChildren.find((c) => c?.type === "class_body" || c?.type === "enum_class_body"));
    definitions.push({
      name,
      kind: isInterface ? "interface" : "class",
      exported: !hidden,
      startLine: line(node),
      endLine: endLine(node),
      signature: signatureOf(node),
      ...(bases.length > 0 ? { bases } : {}),
      ...(methods.length > 0 ? { methods: methods.filter(Boolean) } : {}),
      ...(outer ? { qualified } : {}),
    });
  };

  for (const node of root.namedChildren) {
    if (!node) continue;
    switch (node.type) {
      case "package_header":
        jvmPackage = node.namedChild(0)?.text;
        break;
      case "import": {
        const path = node.namedChildren.find((c) => c?.type === "qualified_identifier")?.text;
        if (!path) break;
        const alias = node.namedChildren.find((c) => c?.type === "identifier")?.text;
        imports.push(jvmImport(path, alias, line(node), /\.\*\s*$/.test(node.text), false));
        break;
      }
      case "class_declaration":
      case "object_declaration":
        typeLike(node, false);
        break;
      case "function_declaration":
        fn(node, undefined, false);
        break;
    }
  }
  return { definitions, imports, ...(jvmPackage ? { jvmPackage } : {}) };
}

// ─── Declared types (Swift, Java, Kotlin) ────────────────────────────────────────────────────────

/** A type as written, if it names one type: not a function type, tuple or array. */
function typeName(node: Node | null | undefined): string | undefined {
  if (!node || /^[([]/.test(node.text)) return undefined;
  const name = lastTypeName(node)?.replace(/[?!]+$/, "");
  return name && /^[\p{L}_][\w]*$/u.test(name) ? name : undefined;
}

/** `Foo(…)` or `new Foo(…)`: the type a value builds, when it's a constructor call. */
function builtType(language: GraphLanguage, value: Node | null | undefined): string | undefined {
  if (!value) return undefined;
  if (language === "java")
    return value.type === "object_creation_expression" ? typeName(value.childForFieldName("type")) : undefined;
  if (value.type !== "call_expression") return undefined;
  const callee = value.namedChildren[0];
  return callee && /identifier$/.test(callee.type) && /^\p{Lu}/u.test(callee.text) ? callee.text : undefined;
}

const KOTLIN_TYPES = new Set(["user_type", "nullable_type"]);
const SWIFT_TYPES = new Set(["user_type", "optional_type", "implicitly_unwrapped_type"]);

function declaredVariables(language: GraphLanguage, root: Node): TypedVariable[] {
  const out: TypedVariable[] = [];
  const add = (name: Node | null | undefined, type: string | undefined, scope: Node | null | undefined) => {
    if (name && type && scope) out.push({ name: name.text, type, startLine: line(scope), endLine: endLine(scope) });
  };
  const visit = (node: Node) => {
    const kids = node.namedChildren.filter((c): c is Node => c !== null);
    if (language === "kotlin") {
      if (node.type === "class_parameter")
        add(
          kids.find((c) => c.type === "identifier"),
          typeName(kids.find((c) => KOTLIN_TYPES.has(c.type))),
          node.parent?.parent?.parent,
        );
      else if (node.type === "parameter" && node.parent?.type === "function_value_parameters")
        add(
          kids.find((c) => c.type === "identifier"),
          typeName(kids.find((c) => KOTLIN_TYPES.has(c.type))),
          node.parent.parent,
        );
      else if (node.type === "property_declaration") {
        const variable = kids.find((c) => c.type === "variable_declaration");
        const parts = variable?.namedChildren.filter((c): c is Node => c !== null) ?? [];
        const written = typeName(parts.find((c) => KOTLIN_TYPES.has(c.type)));
        const scope = node.parent?.type === "class_body" ? node.parent.parent : node.parent;
        add(
          parts.find((c) => c.type === "identifier"),
          written ?? builtType(language, kids.at(-1)),
          scope,
        );
      }
    } else if (language === "java") {
      if (node.type === "field_declaration" || node.type === "local_variable_declaration") {
        const written = node.childForFieldName("type");
        const scope = node.type === "field_declaration" ? node.parent?.parent : node.parent;
        for (const declarator of node.childrenForFieldName("declarator")) {
          if (!declarator) continue;
          const type =
            written?.text === "var" ? builtType(language, declarator.childForFieldName("value")) : typeName(written);
          add(declarator.childForFieldName("name"), type, scope);
        }
      } else if (node.type === "formal_parameter" || node.type === "enhanced_for_statement") {
        const scope = node.type === "formal_parameter" ? node.parent?.parent : node;
        add(node.childForFieldName("name"), typeName(node.childForFieldName("type")), scope);
      }
    } else if (language === "swift") {
      if (node.type === "property_declaration") {
        const name = node.childForFieldName("name")?.childForFieldName("bound_identifier");
        const annotation = kids.find((c) => c.type === "type_annotation")?.childForFieldName("name");
        const scope = node.parent?.type === "class_body" ? node.parent.parent : node.parent;
        add(name, typeName(annotation) ?? builtType(language, node.childForFieldName("value")), scope);
      } else if (node.type === "parameter") {
        const names = node.childrenForFieldName("name").filter((c): c is Node => c !== null);
        add(
          names.find((c) => c.type === "simple_identifier"),
          typeName(names.find((c) => SWIFT_TYPES.has(c.type))),
          node.parent,
        );
      }
    }
    for (const kid of kids) visit(kid);
  };
  visit(root);
  return out;
}

// ─── Entry point ─────────────────────────────────────────────────────────────────────────────────

const queries = new Map<string, Query>();

/** `new Foo()` in Java; in Swift and Kotlin, calling a capitalised name without a receiver builds that type. */
function constructs(language: GraphLanguage, name: Node, object: string | undefined): boolean {
  if (language === "java")
    return name.parent?.type === "object_creation_expression" || name.parent?.type === "generic_type";
  if (language === "swift" || language === "kotlin") {
    return object === undefined && name.parent?.type === "call_expression" && /^\p{Lu}/u.test(name.text);
  }
  return false;
}

/** Definitions, imports and references in one file, or undefined for languages the graph doesn't cover. */
export async function extractSymbols(path: string, source: string): Promise<FileSymbols | undefined> {
  const language = languageOf(path);
  if (!language) return undefined;
  const { parser, language: lang } = await parserFor(language);
  const tree = parser.parse(source);
  if (!tree) return undefined;
  try {
    const root = tree.rootNode;
    const extractors: Record<
      GraphLanguage,
      (root: Node) => Omit<FileSymbols, "language" | "references"> & {
        references?: Reference[];
      }
    > = {
      python: extractPython,
      go: extractGo,
      php: extractPhp,
      ruby: extractRuby,
      swift: extractSwift,
      java: extractJava,
      kotlin: extractKotlin,
      typescript: extractTs,
      tsx: extractTs,
    };
    const extracted = extractors[language](root);
    const { definitions, imports, goPackage, phpNamespace, jvmPackage } = extracted;

    // Ruby's references come from the extractor, which needs more than a query can say (local variables, symbols).
    const references: Reference[] = extracted.references ?? [];
    const source = {
      python: PY_REFERENCES,
      go: GO_REFERENCES,
      php: PHP_REFERENCES,
      swift: SWIFT_REFERENCES,
      java: JAVA_REFERENCES,
      kotlin: KOTLIN_REFERENCES,
      ruby: undefined,
      tsx: TS_REFERENCES + JSX_REFERENCES,
      typescript: TS_REFERENCES,
    }[language];
    let query = queries.get(language);
    if (!query && source) {
      query = new Query(lang, source);
      queries.set(language, query);
    }
    for (const match of query?.matches(root) ?? []) {
      const value = match.captures.find((c) => c.name === "value")?.node;
      const name = value ?? match.captures.find((c) => c.name === "name")?.node;
      const object = match.captures.find((c) => c.name === "object")?.node;
      const qualified = match.captures.find((c) => c.name === "qualified")?.node;
      if (qualified) {
        // PHP `new \\App\\Foo()` or `Foo\\Bar::class`: the name refers to a class directly, so it imports itself.
        const fqn = phpFqn(qualified.text, phpNamespace);
        imports.push({ local: lastSegment(fqn), imported: lastSegment(fqn), from: fqn, line: line(qualified) });
        const kind = phpKind(qualified);
        references.push({ name: lastSegment(fqn), line: line(qualified), ...(kind ? { kind } : {}) });
        continue;
      }
      // Swift's `.chunked(size)`: a static member or enum case of a type the context implies, not a bare call.
      const implicit = match.captures.find((c) => c.name === "implicit")?.node;
      if (implicit) {
        references.push({ name: implicit.text, object: ".", line: line(implicit) });
        continue;
      }
      const type = match.captures.find((c) => c.name === "type")?.node;
      if (type) {
        references.push({ name: type.text, line: line(type), kind: "type" });
        continue;
      }
      if (!name) continue;
      let objectText = object?.text.replace(/\s+/g, "");
      if (language === "php" && object?.type === "qualified_name") {
        const fqn = phpFqn(object.text, phpNamespace);
        imports.push({ local: lastSegment(fqn), imported: lastSegment(fqn), from: fqn, line: line(object) });
        objectText = lastSegment(fqn);
      }
      if (value && !objectText && (value.text.length <= 2 || GO_VALUE_NOISE.has(value.text))) continue;
      const kind =
        language === "php"
          ? phpKind(name)
          : value
            ? "value"
            : constructs(language, name, objectText)
              ? "new"
              : undefined;
      references.push({
        name: name.text,
        ...(objectText ? { object: objectText } : {}),
        line: line(name),
        ...(kind ? { kind } : {}),
      });
    }
    return {
      language,
      ...(goPackage ? { goPackage } : {}),
      ...(phpNamespace ? { phpNamespace } : {}),
      ...(jvmPackage ? { jvmPackage } : {}),
      definitions,
      imports,
      references,
      ...(language === "swift" || language === "java" || language === "kotlin"
        ? { variables: declaredVariables(language, root) }
        : {}),
    };
  } finally {
    tree.delete();
  }
}
