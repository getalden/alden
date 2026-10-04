import type { DiffFile, DiffLine } from "./parse.js";

/** How a language writes comments: line prefixes, and whether it has C-style block comments and Python docstrings. */
interface CommentSyntax {
  line: string[];
  block: boolean;
  docstrings: boolean;
}

const C_LIKE: CommentSyntax = { line: ["//"], block: true, docstrings: false };
const HASH: CommentSyntax = { line: ["#"], block: false, docstrings: false };

function syntaxOf(path: string): CommentSyntax | undefined {
  if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|go|java|kt|swift|rs|dart|cs|c|cc|cpp|h|scss)$/.test(path)) return C_LIKE;
  if (path.endsWith(".php")) return { line: ["//", "#"], block: true, docstrings: false };
  if (path.endsWith(".py")) return { line: ["#"], block: false, docstrings: true };
  if (/\.(rb|sh|ya?ml|toml)$/.test(path)) return HASH;
  return undefined;
}

/**
 * Follows one side of a hunk (old or new lines) and says which changed lines are comments or blank. Block comments
 * and docstrings are tracked from the hunk's first line, so one that opens above the hunk is missed (and its lines
 * count as code, which errs towards flagging).
 */
function commentLines(lines: DiffLine[], syntax: CommentSyntax): Set<DiffLine> {
  const out = new Set<DiffLine>();
  let inBlock = false;
  let inDocstring: string | undefined;
  for (const line of lines) {
    const text = line.text.trim();
    let comment = false;
    if (inBlock) {
      comment = true;
      if (text.includes("*/")) inBlock = false;
    } else if (inDocstring) {
      comment = true;
      if (text.includes(inDocstring)) inDocstring = undefined;
    } else if (text === "" || (syntax.line.some((prefix) => text.startsWith(prefix)) && !text.startsWith("#["))) {
      // (PHP 8's `#[Attribute]` is code, not a comment.)
      comment = true;
    } else if (syntax.block && text.startsWith("/*")) {
      comment = true;
      inBlock = !text.includes("*/", 2);
    } else if (syntax.docstrings && /^[rRbBuU]?("""|''')/.test(text)) {
      // A docstring standing alone: """Text.""" on one line, or opening here and closing below.
      const quote = text.includes('"""') ? '"""' : "'''";
      const rest = text.slice(text.indexOf(quote) + 3);
      comment = true;
      if (!rest.includes(quote)) inDocstring = quote;
    }
    if (comment) out.add(line);
  }
  return out;
}

/**
 * True when every added and removed line of a file is a comment or blank: a change that can't alter behaviour, so it
 * needs no test. False for languages Alden doesn't know the comment syntax of, and for files without a diff.
 */
export function onlyCommentsChanged(file: DiffFile): boolean {
  const syntax = syntaxOf(file.path);
  if (!syntax || file.binary || file.patchMissing || file.hunks.length === 0) return false;
  for (const hunk of file.hunks) {
    const before = commentLines(
      hunk.lines.filter((l) => l.kind !== "add"),
      syntax,
    );
    const after = commentLines(
      hunk.lines.filter((l) => l.kind !== "del"),
      syntax,
    );
    for (const line of hunk.lines) {
      if (line.kind === "del" && !before.has(line)) return false;
      if (line.kind === "add" && !after.has(line)) return false;
    }
  }
  return true;
}

/** A file moved or renamed with no change to its content. */
export const isPureRename = (file: DiffFile) =>
  file.status === "renamed" && file.additions === 0 && file.deletions === 0 && !file.patchMissing;
