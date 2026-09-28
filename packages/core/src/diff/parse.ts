export type FileStatus = "added" | "modified" | "removed" | "renamed";

export interface DiffLine {
  kind: "add" | "del" | "context";
  text: string;
  /** Line number in the old file (deleted and context lines). */
  oldLine?: number;
  /** Line number in the new file (added and context lines). */
  newLine?: number;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  /** The old path, for renames. */
  previousPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** GitHub leaves the patch out for very large files; the file changed but Alden can't see how. */
  patchMissing: boolean;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses the hunks of one file's patch, as GitHub returns it per file (no `diff --git` headers). */
export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let hunk: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      hunk = {
        header: line,
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      continue;
    }
    if (!hunk) continue;
    const marker = line[0];
    const text = line.slice(1);
    if (marker === "+") hunk.lines.push({ kind: "add", text, newLine: newLine++ });
    else if (marker === "-") hunk.lines.push({ kind: "del", text, oldLine: oldLine++ });
    else if (marker === " ") hunk.lines.push({ kind: "context", text, oldLine: oldLine++, newLine: newLine++ });
    // "\ No newline at end of file" and a trailing empty line carry no content.
  }
  return hunks;
}

function count(hunks: Hunk[], kind: DiffLine["kind"]): number {
  return hunks.reduce((sum, h) => sum + h.lines.filter((l) => l.kind === kind).length, 0);
}

/** Undoes git's C-style quoting of unusual paths: "a/caf\303\251.txt" → a/café.txt. */
function unquote(path: string): string {
  if (!path.startsWith('"')) return path;
  const bytes: number[] = [];
  const body = path.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[++i] as string;
    if (/[0-7]/.test(next)) {
      bytes.push(Number.parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else {
      bytes.push(({ n: 10, t: 9, r: 13, '"': 34, "\\": 92 } as Record<string, number>)[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

const stripPrefix = (path: string) => unquote(path).replace(/^[ab]\//, "");

/** Parses `git diff` output (one or many files, with headers) into files and hunks. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const blocks = text.split(/^(?=diff --git )/m).filter((b) => b.startsWith("diff --git "));

  for (const block of blocks) {
    const lines = block.split("\n");
    let oldPath: string | undefined;
    let newPath: string | undefined;
    let status: FileStatus = "modified";
    let binary = false;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    let bodyStart = lines.length;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] as string;
      if (line.startsWith("@@")) {
        bodyStart = i;
        break;
      }
      if (line.startsWith("new file mode")) status = "added";
      else if (line.startsWith("deleted file mode")) status = "removed";
      else if (line.startsWith("rename from ")) renameFrom = unquote(line.slice(12));
      else if (line.startsWith("rename to ")) renameTo = unquote(line.slice(10));
      else if (line.startsWith("Binary files ") || line === "GIT binary patch") binary = true;
      else if (line.startsWith("--- "))
        oldPath = line.slice(4) === "/dev/null" ? undefined : stripPrefix(line.slice(4));
      else if (line.startsWith("+++ "))
        newPath = line.slice(4) === "/dev/null" ? undefined : stripPrefix(line.slice(4));
    }

    if (renameFrom && renameTo) status = "renamed";
    // Binary and pure-rename blocks have no ---/+++ lines; fall back to the rename or `diff --git` header.
    const headerPaths = /^diff --git (\S+|"[^"]*") (\S+|"[^"]*")$/.exec(lines[0] as string);
    const path = renameTo ?? newPath ?? oldPath ?? (headerPaths ? stripPrefix(headerPaths[2] as string) : "");
    const hunks = parseHunks(lines.slice(bodyStart).join("\n"));
    const previousPath = status === "renamed" ? (renameFrom ?? oldPath) : undefined;

    files.push({
      path,
      ...(previousPath ? { previousPath } : {}),
      status,
      additions: count(hunks, "add"),
      deletions: count(hunks, "del"),
      binary,
      patchMissing: false,
      hunks,
    });
  }
  return files;
}

/** Added lines across a file's hunks, with their line numbers in the new file. */
export function addedLines(file: DiffFile): { line: number; text: string }[] {
  return file.hunks.flatMap((h) =>
    h.lines.filter((l) => l.kind === "add").map((l) => ({ line: l.newLine ?? 0, text: l.text })),
  );
}
