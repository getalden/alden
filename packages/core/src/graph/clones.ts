import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { type AldenStore, openStore } from "../store/db.js";
import { repoFromRemote } from "./checkout.js";

const run = promisify(execFile);

/** A local clone: its top folder and the GitHub repos ("owner/name", lowercase) its remotes point at. */
export interface Clone {
  root: string;
  repos: string[];
}

/** Where a PR's clone was found: the folder Alden runs in, one it saw before, or one under `clones.folders`. */
export type CloneFound = { path: string; how: "here" | "remembered" | "folders" };

const KEY = (repo: string) => `clone:${repo.toLowerCase()}`;

/** How deep `clones.folders` are searched (~/src/repo is 1, ~/src/github.com/owner/repo is 3), and how widely. */
const MAX_DEPTH = 3;
const MAX_DIRS = 4_000;

/** The clone around `cwd`, or undefined outside one. */
export async function cloneAt(cwd: string): Promise<Clone | undefined> {
  try {
    const { stdout: root } = await run("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 10_000 });
    return { root: root.trim(), repos: await remotesOf(root.trim()) };
  } catch {
    return undefined;
  }
}

async function remotesOf(root: string): Promise<string[]> {
  const { stdout } = await run("git", ["remote", "-v"], { cwd: root, timeout: 10_000 });
  return [...new Set(stdout.split("\n").flatMap((l) => repoFromRemote(l.split(/\s+/)[1] ?? "") ?? []))];
}

/** The remotes in a clone's .git/config, read without starting git: a folder of clones can hold hundreds. */
function remotesInConfig(gitDir: string): string[] {
  try {
    const config = readFileSync(join(gitDir, "config"), "utf8");
    return [...new Set([...config.matchAll(/^\s*url\s*=\s*(.+)$/gm)].flatMap((m) => repoFromRemote(m[1] ?? "") ?? []))];
  } catch {
    return [];
  }
}

/** Remembers that `root` is a clone of `repo`, so briefings on its PRs find callers there from anywhere. */
export function rememberClone(repo: string, root: string, store: AldenStore = openStore()): void {
  store.run(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    KEY(repo),
    resolve(root),
  );
}

/** The clone Alden last saw for `repo`, unchecked. */
export function rememberedClone(repo: string, store: AldenStore = openStore()): string | undefined {
  return store.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", KEY(repo))?.value;
}

/** Records the clone Alden is running in, if it is one with a GitHub remote. Never fails. */
export async function noteClone(cwd: string, store?: AldenStore): Promise<Clone | undefined> {
  try {
    const clone = await cloneAt(cwd);
    if (!clone) return undefined;
    const db = store ?? openStore();
    for (const repo of clone.repos)
      if (rememberedClone(repo, db) !== resolve(clone.root)) rememberClone(repo, clone.root, db);
    return clone;
  } catch {
    return undefined;
  }
}

/** `~/src` → the home folder's src. */
export function expandHome(folder: string): string {
  return resolve(folder.replace(/^~(?=$|[/\\])/, homedir()));
}

/** Every clone under `folder`, up to a few levels down; a clone's own subfolders aren't searched. */
export async function clonesUnder(folder: string): Promise<Clone[]> {
  const found: Clone[] = [];
  let seen = 0;
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (seen++ > MAX_DIRS) return;
    const git = join(dir, ".git");
    if (existsSync(git)) {
      // A worktree or submodule has a .git file pointing elsewhere: ask git.
      const repos = statSync(git).isDirectory() ? remotesInConfig(git) : await remotesOf(dir).catch(() => []);
      if (repos.length > 0) found.push({ root: dir, repos });
      return;
    }
    if (depth >= MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
        .map((e) => e.name);
    } catch {
      return;
    }
    for (const name of entries) await visit(join(dir, name), depth + 1);
  };
  await visit(expandHome(folder), 0);
  return found;
}

/**
 * The local clone to find a PR's callers in, in order: the clone Alden runs in, if it has a remote for `repo`; the
 * clone Alden last saw for it (if it's still there and still has that remote); then the first under `folders` (the
 * `clones.folders` setting). Everything found is remembered for next time. Undefined when there's none.
 */
export async function findClone(
  repo: string,
  options: { cwd: string; folders?: string[]; store?: AldenStore },
): Promise<CloneFound | undefined> {
  const wanted = repo.toLowerCase();
  let store: AldenStore | undefined;
  try {
    store = options.store ?? openStore();
  } catch {
    // No database: still look here and in the folders, just without remembering.
  }

  const here = await cloneAt(options.cwd);
  if (here) {
    if (store) for (const r of here.repos) rememberClone(r, here.root, store);
    if (here.repos.includes(wanted)) return { path: here.root, how: "here" };
  }

  const remembered = store ? rememberedClone(wanted, store) : undefined;
  if (remembered) {
    const still = existsSync(remembered) && (await remotesOf(remembered).catch(() => [])).includes(wanted);
    if (still) return { path: remembered, how: "remembered" };
    store?.run("DELETE FROM meta WHERE key = ?", KEY(wanted));
  }

  let match: string | undefined;
  for (const folder of options.folders ?? []) {
    for (const clone of await clonesUnder(folder)) {
      if (store) for (const r of clone.repos) if (!rememberedClone(r, store)) rememberClone(r, clone.root, store);
      if (!match && clone.repos.includes(wanted)) match = clone.root;
    }
    if (match) break;
  }
  if (match) {
    if (store) rememberClone(wanted, match, store);
    return { path: match, how: "folders" };
  }
  return undefined;
}
