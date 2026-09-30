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
};

function language(path: string): keyof typeof DECLARATIONS | undefined {
  if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(path)) return "ts";
  if (path.endsWith(".py")) return "py";
  if (path.endsWith(".php")) return "php";
  if (path.endsWith(".go")) return "go";
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
  if ((lang === "php" || lang === "ts") && /\b(private|protected)\b/.test(head)) return undefined;
  for (const pattern of DECLARATIONS[lang] ?? []) {
    const name = pattern.exec(text)?.[1];
    if (name) return { name, signature: normalise(text) };
  }
  return undefined;
}

export type SignatureChange =
  | { kind: "changed"; before: Declaration; after: Declaration }
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
const hasGraphSignatures = (path: string) => path.endsWith(".go") || path.endsWith(".php");

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
      });
    }
  }
  const unmatched = new Set(added);
  for (const before of removed) {
    const moved = [...unmatched].find((a) => key(a) === key(before) && a.signature === before.signature);
    if (moved) {
      unmatched.delete(moved);
      // Within one Go package, moving between files changes nothing for callers. (A PHP class's file is its name.)
      if (!moved.path.endsWith(".go") || posix.dirname(moved.path) !== posix.dirname(before.path)) {
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
      if (edited.signature !== before.signature) changes.push({ kind: "changed", before, after: edited });
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
