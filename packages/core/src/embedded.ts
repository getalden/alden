/**
 * Files built into a standalone `alden` binary (the grammars, web-tree-sitter's runtime, the web UI), by path, e.g.
 * "grammars/tree-sitter-go.wasm" or "ui/index.html". Empty when Alden runs from npm, where they're files on disk.
 */
const files = new Map<string, Uint8Array>();

export function registerEmbeddedFiles(entries: Iterable<[string, Uint8Array]>): void {
  for (const [path, bytes] of entries) files.set(path, bytes);
}

export function embeddedFile(path: string): Uint8Array | undefined {
  return files.get(path);
}

/** Embedded files under a prefix ("ui/"), keyed without it. */
export function embeddedFilesUnder(prefix: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [path, bytes] of files) if (path.startsWith(prefix)) out.set(path.slice(prefix.length), bytes);
  return out;
}

/** Whether this is a standalone binary (which can't load packages installed beside it). */
export function isStandaloneBinary(): boolean {
  return files.size > 0;
}
