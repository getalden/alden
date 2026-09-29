import type { DiffFile } from "../diff/parse.js";
import { reverseApply } from "../review/manifests.js";
import { type Definition, extractSymbols, type FileSymbols } from "./extract.js";
import { languageOf } from "./parser.js";

export type SymbolChange = "added" | "modified" | "removed";

/** A function, method, class or export whose code the diff touches. */
export interface ChangedSymbol {
  path: string;
  name: string;
  kind: Definition["kind"];
  container?: string;
  exported: boolean;
  change: SymbolChange;
  /** New-file lines of the definition (old-file lines for removed ones). */
  startLine: number;
  endLine: number;
  /** How many changed lines fall inside it. */
  changedLines: number;
}

/**
 * Where each changed line lands in the new file. Added lines have their own number; a deleted line is placed at the
 * new-file line that follows it, so deleting from a function's middle still counts as changing that function.
 */
export function changedNewLines(file: DiffFile): Set<number> {
  const lines = new Set<number>();
  for (const hunk of file.hunks) {
    let next = hunk.newStart;
    let pendingDeletion = false;
    for (const line of hunk.lines) {
      if (line.kind === "del") {
        pendingDeletion = true;
        continue;
      }
      if (pendingDeletion) lines.add(line.newLine ?? next);
      pendingDeletion = false;
      if (line.kind === "add" && line.newLine !== undefined) lines.add(line.newLine);
      if (line.newLine !== undefined) next = line.newLine + 1;
    }
    if (pendingDeletion) lines.add(Math.max(1, next - 1));
  }
  return lines;
}

/** Lines that exist only in the new file (the whole definition is new when all of its lines are here). */
function addedNewLines(file: DiffFile): Set<number> {
  const lines = new Set<number>();
  for (const hunk of file.hunks)
    for (const l of hunk.lines) if (l.kind === "add" && l.newLine !== undefined) lines.add(l.newLine);
  return lines;
}

const key = (d: Definition) => `${d.container ?? ""}.${d.name}`;

/**
 * The definitions a diff changes, innermost first: a change inside a method reports the method, not its class; a
 * change between methods (a class attribute, a decorator) reports the class.
 *
 * `after` are the new versions of the changed files. `before` (optional) are the old versions, used to find
 * definitions the diff removed entirely.
 */
export function changedSymbols(
  files: DiffFile[],
  after: Map<string, FileSymbols>,
  before: Map<string, FileSymbols> = new Map(),
): ChangedSymbol[] {
  const out: ChangedSymbol[] = [];
  for (const file of files) {
    const symbols = after.get(file.path);
    const old = before.get(file.previousPath ?? file.path);
    const existedBefore = old ? new Set(old.definitions.map(key)) : undefined;
    const changed = file.status === "removed" ? new Set<number>() : changedNewLines(file);
    const added = addedNewLines(file);

    if (symbols) {
      // Innermost definition per changed line: the one with the smallest span that contains it.
      const hits = new Map<Definition, number>();
      for (const lineNumber of changed) {
        let best: Definition | undefined;
        for (const def of symbols.definitions) {
          if (lineNumber < def.startLine || lineNumber > def.endLine) continue;
          if (!best || def.endLine - def.startLine < best.endLine - best.startLine) best = def;
        }
        if (best) hits.set(best, (hits.get(best) ?? 0) + 1);
      }
      for (const [def, count] of hits) {
        // New if the old version didn't have it. Without the old version, if every line of it is an added line
        // (which misses a new function that reuses a neighbour's closing brace as diff context).
        let allNew = true;
        if (existedBefore) allNew = !existedBefore.has(key(def));
        else for (let l = def.startLine; l <= def.endLine && allNew; l++) allNew = added.has(l);
        out.push({
          path: file.path,
          name: def.name,
          kind: def.kind,
          ...(def.container ? { container: def.container } : {}),
          exported: def.exported,
          change: allNew || file.status === "added" ? "added" : "modified",
          startLine: def.startLine,
          endLine: def.endLine,
          changedLines: count,
        });
      }
    }

    // Definitions present before and gone after were removed (or renamed away).
    if (old) {
      const still = new Set((symbols?.definitions ?? []).map(key));
      for (const def of old.definitions) {
        if (still.has(key(def))) continue;
        out.push({
          path: file.path,
          name: def.name,
          kind: def.kind,
          ...(def.container ? { container: def.container } : {}),
          exported: def.exported,
          change: "removed",
          startLine: def.startLine,
          endLine: def.endLine,
          changedLines: def.endLine - def.startLine + 1,
        });
      }
    }
  }
  return out;
}

/**
 * Parses both versions of every changed file the graph covers. `readAfter` returns a file's new content (from the
 * working tree or a PR checkout); the old content is rebuilt by reverse-applying the diff, so no base checkout is
 * needed. Files whose diff GitHub didn't send, or that can't be read, are left out.
 */
export async function loadChangeSymbols(
  files: DiffFile[],
  readAfter: (path: string) => Promise<string | undefined>,
): Promise<{ after: Map<string, FileSymbols>; before: Map<string, FileSymbols> }> {
  const after = new Map<string, FileSymbols>();
  const before = new Map<string, FileSymbols>();
  for (const file of files) {
    if (file.binary || file.patchMissing || !languageOf(file.path)) continue;
    const content = file.status === "removed" ? "" : await readAfter(file.path);
    if (content === undefined) continue;
    if (file.status !== "removed") {
      const symbols = await extractSymbols(file.path, content);
      if (symbols) after.set(file.path, symbols);
    }
    if (file.status !== "added") {
      const oldPath = file.previousPath ?? file.path;
      const symbols = await extractSymbols(oldPath, reverseApply(content, file));
      if (symbols) before.set(oldPath, symbols);
    }
  }
  return { after, before };
}
