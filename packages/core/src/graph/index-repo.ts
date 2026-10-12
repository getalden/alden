import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { aldenHome } from "../config.js";
import { extractSymbols, type FileSymbols } from "./extract.js";
import { languageOf } from "./parser.js";

const run = promisify(execFile);

/** Bump when extraction output changes shape or meaning, so old caches are dropped instead of trusted. */
export const EXTRACTOR_VERSION = 7;

/** Files bigger than this are usually generated or vendored; skipping keeps indexing predictable. */
const MAX_FILE_BYTES = 512 * 1024;
const SKIP =
  /(^|\/)(node_modules|vendor|dist|build|\.next|__pycache__|site-packages)\/|\.min\.(js|mjs|cjs)$|\.bundle\.js$/;

export interface RepoIndex {
  root: string;
  files: Map<string, FileSymbols>;
  /** False when the time budget ran out; `files` then holds what was indexed. */
  complete: boolean;
  /** Paths left out: too big, vendored or generated, or unreadable. */
  skipped: string[];
  stats: { candidates: number; parsed: number; fromCache: number; ms: number };
}

interface CacheFile {
  version: number;
  /** Content key (git blob hash or content hash) → symbols. */
  symbols: Record<string, FileSymbols>;
}

export interface IndexOptions {
  /** Stop parsing after this long and return what's indexed. Defaults to 60 seconds. */
  budgetMs?: number;
  cacheDir?: string;
  now?: () => number;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-c", "core.quotepath=off", ...args], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

const splitZ = (text: string) => text.split("\0").filter(Boolean);

/**
 * Every file the graph covers, with a key that changes exactly when its content does: the git blob hash for files
 * unchanged since the last `git add`, or a hash of the working-tree content for modified and untracked files.
 */
async function listFiles(root: string): Promise<{ path: string; key?: string }[]> {
  const staged = new Map<string, string>();
  for (const entry of splitZ(await git(root, ["ls-files", "-s", "-z"]))) {
    // "<mode> <sha> <stage>\t<path>"
    const tab = entry.indexOf("\t");
    const sha = entry.split(" ")[1];
    if (tab > 0 && sha) staged.set(entry.slice(tab + 1), sha);
  }
  const modified = new Set(splitZ(await git(root, ["ls-files", "-m", "-z"])));
  const deleted = new Set(splitZ(await git(root, ["ls-files", "-d", "-z"])));
  const untracked = splitZ(await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]));

  const files: { path: string; key?: string }[] = [];
  for (const [path, sha] of staged) {
    if (!languageOf(path) || deleted.has(path)) continue;
    files.push(modified.has(path) ? { path } : { path, key: `blob:${sha}` });
  }
  for (const path of untracked) if (languageOf(path)) files.push({ path });
  return files;
}

async function loadCache(file: string): Promise<CacheFile> {
  try {
    const cache = JSON.parse(await readFile(file, "utf8")) as CacheFile;
    if (cache.version === EXTRACTOR_VERSION) return cache;
  } catch {
    // Missing or corrupt: start fresh.
  }
  return { version: EXTRACTOR_VERSION, symbols: {} };
}

/** Where a repo's cache lives: one file per repo root, under ~/.alden/index. */
export function indexCachePath(root: string, cacheDir: string = join(aldenHome(), "index")): string {
  return join(cacheDir, `${createHash("sha256").update(root).digest("hex").slice(0, 16)}.json`);
}

/**
 * Parses the repo's TypeScript, JavaScript and Python files into symbols, reusing cached results for unchanged
 * content. Stops at the time budget rather than holding up a review.
 */
export async function indexRepo(root: string, options: IndexOptions = {}): Promise<RepoIndex> {
  const now = options.now ?? Date.now;
  const started = now();
  const budgetMs = options.budgetMs ?? 60_000;
  const cachePath = indexCachePath(root, options.cacheDir);
  const cache = await loadCache(cachePath);
  const used: Record<string, FileSymbols> = {};

  const files = new Map<string, FileSymbols>();
  const skipped: string[] = [];
  let parsed = 0;
  let fromCache = 0;
  let complete = true;

  const listed = await listFiles(root);
  for (const file of listed) {
    if (SKIP.test(file.path)) {
      skipped.push(file.path);
      continue;
    }
    const cached = file.key ? cache.symbols[file.key] : undefined;
    if (cached && file.key) {
      files.set(file.path, cached);
      used[file.key] = cached;
      fromCache++;
      continue;
    }
    if (now() - started > budgetMs) {
      complete = false;
      break;
    }
    const full = join(root, file.path);
    let source: string;
    try {
      if ((await stat(full)).size > MAX_FILE_BYTES) {
        skipped.push(file.path);
        continue;
      }
      source = await readFile(full, "utf8");
    } catch {
      skipped.push(file.path);
      continue;
    }
    const key = file.key ?? `content:${createHash("sha1").update(source).digest("hex")}`;
    const symbols = cache.symbols[key] ?? (await extractSymbols(file.path, source));
    if (!symbols) continue;
    if (cache.symbols[key]) fromCache++;
    else parsed++;
    files.set(file.path, symbols);
    used[key] = symbols;
  }

  // Keep only what this checkout uses, so the cache doesn't grow forever. Written atomically.
  await mkdir(join(cachePath, ".."), { recursive: true });
  const temp = `${cachePath}.${process.pid}.tmp`;
  await writeFile(
    temp,
    JSON.stringify({ version: EXTRACTOR_VERSION, symbols: { ...(complete ? {} : cache.symbols), ...used } }),
  );
  await rename(temp, cachePath);

  return {
    root,
    files,
    complete,
    skipped,
    stats: { candidates: listed.length, parsed, fromCache, ms: now() - started },
  };
}
