import { type Node, Query } from "web-tree-sitter";
import { type GraphLanguage, languageOf, parserFor } from "./parser.js";

export type DefinitionKind = "function" | "class" | "method" | "variable" | "interface" | "type";

/** Something a file defines. Lines are 1-based and inclusive, matching diff line numbers. */
export interface Definition {
  name: string;
  kind: DefinitionKind;
  /** Usable from other files: exported in TS/JS, not underscore-prefixed in Python. */
  exported: boolean;
  startLine: number;
  endLine: number;
  /** The class a method belongs to. */
  container?: string;
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
}

/** A use of a name: a call, `new`, a JSX element, a base class, or passed as an argument (callbacks, Django urls). */
export interface Reference {
  name: string;
  /** For `obj.name(...)`, the object's text, e.g. "ns" or "self". */
  object?: string;
  line: number;
}

export interface FileSymbols {
  language: GraphLanguage;
  definitions: Definition[];
  imports: ImportBinding[];
  references: Reference[];
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

// ─── Entry point ─────────────────────────────────────────────────────────────────────────────────

const queries = new Map<string, Query>();

/** Definitions, imports and references in one file, or undefined for languages the graph doesn't cover. */
export async function extractSymbols(path: string, source: string): Promise<FileSymbols | undefined> {
  const language = languageOf(path);
  if (!language) return undefined;
  const { parser, language: lang } = await parserFor(language);
  const tree = parser.parse(source);
  if (!tree) return undefined;
  try {
    const root = tree.rootNode;
    const { definitions, imports } = language === "python" ? extractPython(root) : extractTs(root);

    const queryKey = language === "python" ? "python" : language;
    let query = queries.get(queryKey);
    if (!query) {
      const source =
        language === "python" ? PY_REFERENCES : language === "tsx" ? TS_REFERENCES + JSX_REFERENCES : TS_REFERENCES;
      query = new Query(lang, source);
      queries.set(queryKey, query);
    }
    const references: Reference[] = [];
    for (const match of query.matches(root)) {
      const name = match.captures.find((c) => c.name === "name")?.node;
      const object = match.captures.find((c) => c.name === "object")?.node;
      if (name) references.push({ name: name.text, ...(object ? { object: object.text } : {}), line: line(name) });
    }
    return { language, definitions, imports, references };
  } finally {
    tree.delete();
  }
}
