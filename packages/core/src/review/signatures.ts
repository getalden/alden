import { posix } from "node:path";
import type { DiffFile } from "../diff/parse.js";
import type { ChangedSymbol } from "../graph/changes.js";
import { fileKind } from "../queue/files.js";

/**
 * Public declarations recognisable from a single line, per language. Group 1 is the name. Multi-line signatures are
 * compared by their first line only, and methods are keyed by name within a file, so this is a heuristic until the
 * code graph (weeks 4–6) can resolve symbols properly.
 */
const DECLARATIONS: Record<string, RegExp[]> = {
  ts: [
    /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
    /^\s*export\s+(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>|function)/,
    /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^\s*export\s+(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    /^\s*public\s+(?:static\s+)?(?:async\s+)?(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[(<]/,
  ],
  py: [
    /^(?:async\s+)?def\s+([A-Za-z]\w*)\s*\(/, // module-level; a leading underscore means private
    /^class\s+([A-Za-z]\w*)/,
    /^ {4}(?:async\s+)?def\s+([A-Za-z]\w*)\s*\(/, // methods one level in
  ],
  php: [
    /^\s*(?:final\s+|abstract\s+)*(?:public\s+)?(?:static\s+)?function\s+([A-Za-z_]\w*)\s*\(/, // no modifier = public; includes __construct
    /^\s*(?:final\s+|abstract\s+|readonly\s+)*(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/,
  ],
  go: [/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)\s*[([]/, /^type\s+([A-Z]\w*)\s/],
  // Ruby's `private` is a section, not a modifier on the line, so private methods count too until the graph reads them.
  rb: [/^\s*def\s+(?:self\.)?([a-z_]\w*[?!=]?)/, /^\s*(?:class|module)\s+([A-Z]\w*(?:::[A-Z]\w*)*)/],
  swift: [
    /^\s*(?:@\w+\s+)*(?:(?:public|open|internal|static|class|final|override|mutating|nonisolated)\s+)*func\s+([A-Za-z_]\w*)/,
    /^\s*(?:@\w+\s+)*(?:(?:public|open|internal|final)\s+)*(?:class|struct|enum|protocol|actor)\s+([A-Za-z_]\w*)/,
  ],
  java: [
    /^\s*(?:public|protected)\s+(?:(?:static|final|abstract|synchronized|default)\s+)*(?:<[^>]+>\s+)?[\w.<>[\], ?]+\s+([a-zA-Z_]\w*)\s*\(/,
    /^\s*(?:public\s+)?(?:(?:abstract|final|static|sealed)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/,
  ],
  kt: [
    /^\s*(?:(?:public|internal|open|override|suspend|inline|operator|infix|abstract)\s+)*fun\s+(?:<[^>]+>\s+)?(?:[\w.]+\.)?([a-zA-Z_]\w*)\s*\(/,
    /^\s*(?:(?:public|internal|open|abstract|sealed|data|enum|inner|value|annotation)\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/,
  ],
};

function language(path: string): keyof typeof DECLARATIONS | undefined {
  if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(path)) return "ts";
  if (path.endsWith(".py")) return "py";
  if (path.endsWith(".php")) return "php";
  if (path.endsWith(".go")) return "go";
  if (path.endsWith(".rb")) return "rb";
  if (path.endsWith(".swift")) return "swift";
  if (path.endsWith(".java")) return "java";
  if (/\.kts?$/.test(path)) return "kt";
  return undefined;
}

/** A declaration's first line without its body opener or trailing comment, whitespace collapsed. */
function normalise(line: string): string {
  return line
    .replace(/\/\/.*$|#.*$/, "")
    .replace(/\s*(\{|=>\s*\{?|:)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface Declaration {
  name: string;
  /** For methods the code graph found, the type they belong to. */
  container?: string;
  signature: string;
  path: string;
  /** Line in the new file, for added declarations. */
  line?: number;
}

export function declarationIn(path: string, text: string): { name: string; signature: string } | undefined {
  const lang = language(path);
  if (!lang) return undefined;
  // Only modifiers before the parameter list count: `__construct(private Mailer $m)` is still a public constructor.
  const head = text.split("(")[0] ?? text;
  if ((lang === "php" || lang === "ts" || lang === "kt") && /\b(private|protected)\b/.test(head)) return undefined;
  if (lang === "java" && /\bprivate\b/.test(head)) return undefined;
  if (lang === "swift" && /\b(private|fileprivate)\b/.test(head)) return undefined;
  for (const pattern of DECLARATIONS[lang] ?? []) {
    const name = pattern.exec(text)?.[1];
    if (name) return { name, signature: normalise(text) };
  }
  return undefined;
}

export type SignatureChange =
  /** `compatible`: only parameters callers needn't pass were added (see `compatibleChange`). */
  | { kind: "changed"; before: Declaration; after: Declaration; compatible: boolean }
  | { kind: "removed"; before: Declaration }
  | { kind: "added"; after: Declaration }
  | { kind: "moved"; before: Declaration; after: Declaration };

/** Public declarations that changed, disappeared, appeared or moved between files. Tests are ignored. */
export function signatureChanges(files: DiffFile[], graph?: GraphSignatures): SignatureChange[] {
  // Files the code graph parsed with signatures come from the graph; the rest from the diff alone.
  const fromGraph = graph ? files.filter((f) => graph.covered?.has(f.path) && hasGraphSignatures(f.path)) : [];
  const byGraph = new Set(fromGraph.map((f) => f.path));
  const heuristic = diffSignatureChanges(files.filter((f) => !byGraph.has(f.path)));
  if (!graph || fromGraph.length === 0) return heuristic;
  return [...heuristic, ...graphSignatureChanges(graph.changes.filter((c) => byGraph.has(c.path)))];
}

/** What the signature check needs from the code graph. */
export interface GraphSignatures {
  changes: ChangedSymbol[];
  /** Changed files the graph parsed. */
  covered?: Set<string>;
}

/** Languages whose definitions carry their signature in the graph. */
const hasGraphSignatures = (path: string) => /\.(go|php|rb|rake|swift|java|kts?)$/.test(path);

/** Ruby and Swift files share one namespace: a declaration moving between them changes nothing for callers. */
const sameNamespace = (a: string, b: string) =>
  (a.endsWith(".go") && b.endsWith(".go") && posix.dirname(a) === posix.dirname(b)) ||
  (/\.(rb|rake)$/.test(a) && /\.(rb|rake)$/.test(b)) ||
  (a.endsWith(".swift") && b.endsWith(".swift"));

const declaration = (c: ChangedSymbol, signature: string, withLine: boolean): Declaration => ({
  name: c.name,
  ...(c.container ? { container: c.container } : {}),
  signature,
  path: c.path,
  ...(withLine ? { line: c.startLine } : {}),
});

/**
 * Signature changes from the graph's before-and-after parse: keyed by type and name, so two types' Close methods
 * don't collide, and whole declarations, so multi-line parameter lists compare properly.
 */
export function graphSignatureChanges(changes: ChangedSymbol[]): SignatureChange[] {
  const out: SignatureChange[] = [];
  const isTest = (c: ChangedSymbol) => fileKind(c.path) === "test";
  const key = (c: ChangedSymbol) => `${c.container ?? ""}.${c.name}`;
  const removed = changes.filter((c) => c.exported && !isTest(c) && c.change === "removed" && c.signature);
  const added = changes.filter((c) => c.exported && !isTest(c) && c.change === "added" && c.signature);

  for (const c of changes) {
    if (!c.exported || isTest(c) || c.change !== "modified") continue;
    if (c.signature && c.previousSignature && c.signature !== c.previousSignature) {
      out.push({
        kind: "changed",
        before: declaration(c, c.previousSignature, false),
        after: declaration(c, c.signature, true),
        compatible: compatibleChange(c.previousSignature, c.signature, c.path),
      });
    }
  }
  const unmatched = new Set(added);
  for (const before of removed) {
    const moved = [...unmatched].find((a) => key(a) === key(before) && a.signature === before.signature);
    if (moved) {
      unmatched.delete(moved);
      // Within one Go package (or a Ruby app, a Swift module), moving between files changes nothing for callers.
      if (!sameNamespace(moved.path, before.path)) {
        out.push({
          kind: "moved",
          before: declaration(before, before.signature ?? "", false),
          after: declaration(moved, moved.signature ?? "", true),
        });
      }
      continue;
    }
    out.push({ kind: "removed", before: declaration(before, before.signature ?? "", false) });
  }
  for (const after of unmatched) out.push({ kind: "added", after: declaration(after, after.signature ?? "", true) });
  return out;
}

/** The diff-only heuristic: declarations recognisable from single changed lines. */
function diffSignatureChanges(files: DiffFile[]): SignatureChange[] {
  const removed: Declaration[] = [];
  const added: Declaration[] = [];

  for (const file of files) {
    if (fileKind(file.path) !== "code") continue;
    const oldPath = file.previousPath ?? file.path;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "context") continue;
        const decl = declarationIn(file.path, line.text);
        if (!decl) continue;
        if (line.kind === "del") removed.push({ ...decl, path: oldPath });
        else added.push({ ...decl, path: file.path, ...(line.newLine ? { line: line.newLine } : {}) });
      }
    }
  }

  const changes: SignatureChange[] = [];
  const unmatchedAdded = new Set(added);
  for (const before of removed) {
    // Same file (after renames) and same name: an edit. Identical text means only its body lines moved around.
    const edited = [...unmatchedAdded].find(
      (a) =>
        a.name === before.name &&
        (a.path === before.path || files.some((f) => f.previousPath === before.path && f.path === a.path)),
    );
    if (edited) {
      unmatchedAdded.delete(edited);
      if (edited.signature !== before.signature) {
        changes.push({
          kind: "changed",
          before,
          after: edited,
          compatible: compatibleChange(before.signature, edited.signature, edited.path),
        });
      }
      continue;
    }
    const moved = [...unmatchedAdded].find((a) => a.name === before.name && a.signature === before.signature);
    if (moved) {
      unmatchedAdded.delete(moved);
      changes.push({ kind: "moved", before, after: moved });
      continue;
    }
    changes.push({ kind: "removed", before });
  }
  for (const after of unmatchedAdded) changes.push({ kind: "added", after });
  return changes;
}

/** A declaration split around its parameter list, or undefined when the list isn't complete (a cut-off first line). */
export function splitParameters(signature: string): { head: string; params: string[]; tail: string } | undefined {
  const open = signature.indexOf("(");
  if (open === -1) return undefined;
  const params: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = open + 1;
  for (let i = open; i < signature.length; i++) {
    const ch = signature[i] as string;
    if (quote) {
      if (ch === quote && signature[i - 1] !== "\\") quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch) && !(ch === ">" && signature[i - 1] === "=")) {
      depth--;
      if (depth === 0) {
        const last = signature.slice(start, i).trim();
        if (last) params.push(last);
        return { head: signature.slice(0, open), params, tail: signature.slice(i + 1).trim() };
      }
    } else if (ch === "," && depth === 1) {
      params.push(signature.slice(start, i).trim());
      start = i + 1;
    }
  }
  return undefined;
}

/**
 * A parameter every existing call already satisfies: it has a default (`b = 1`, `$b = 1`), is optional (`b?: T`),
 * collects the rest (`...rest`, `*args`, `**kwargs`, Go's `xs ...T`), or is Python's bare `*` separator. In Ruby, a
 * keyword with a default (`from: nil`) or a block (`&block`) too; a bare `from:` is required.
 */
function optionalParameter(param: string, ruby = false): boolean {
  if (ruby && (/^\w+:\s*\S/.test(param) || /^&\w*$/.test(param))) return true;
  return /=/.test(param) || /^[\w$]+\?\s*:/.test(param) || /\.\.\./.test(param) || /^\*{1,2}\w*/.test(param);
}

/**
 * Whether callers written against `before` still work with `after`: same name, return type and existing parameters,
 * plus only parameters callers needn't pass. `f(a)` → `f(a, b = 1)` is compatible; `f(a)` → `f(a, b)` or `f(b)` isn't.
 */
export function compatibleChange(before: string, after: string, path = ""): boolean {
  const old = splitParameters(before);
  const now = splitParameters(after);
  if (!old || !now) return false;
  if (old.head !== now.head || old.tail !== now.tail || now.params.length <= old.params.length) return false;
  if (old.params.some((p, i) => p !== now.params[i])) return false;
  const ruby = /\.(rb|rake)$/.test(path);
  return now.params.slice(old.params.length).every((p) => optionalParameter(p, ruby));
}
