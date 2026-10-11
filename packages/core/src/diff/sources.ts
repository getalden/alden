import { execFile } from "node:child_process";
import { open, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { GitHubClient } from "../github/client.js";
import { type DiffFile, type FileStatus, parseHunks, parseUnifiedDiff } from "./parse.js";

const run = promisify(execFile);

/** GitHub's files API stops at 3000 files per PR. */
const MAX_PR_FILES = 3000;
/** Untracked files bigger than this are listed but not read. */
const MAX_UNTRACKED_BYTES = 1_000_000;

interface RestFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

function restStatus(status: string): FileStatus {
  if (status === "added" || status === "removed" || status === "renamed") return status;
  return "modified"; // modified, changed, copied, unchanged
}

/** Converts one entry of GitHub's "list pull request files" response. */
export function fromRestFile(file: RestFile): DiffFile {
  const hunks = file.patch ? parseHunks(file.patch) : [];
  const changed = file.additions + file.deletions > 0;
  return {
    path: file.filename,
    ...(file.previous_filename ? { previousPath: file.previous_filename } : {}),
    status: restStatus(file.status),
    additions: file.additions,
    deletions: file.deletions,
    // GitHub omits the patch for binary files, for text diffs too large to show, and for a move with no edits.
    binary: !file.patch && !changed && file.status !== "renamed",
    patchMissing: !file.patch && changed,
    hunks,
  };
}

/** A PR's changed files with their hunks, from GitHub. */
export async function fetchPullRequestDiff(client: GitHubClient, repo: string, number: number): Promise<DiffFile[]> {
  const [owner, name] = repo.split("/") as [string, string];
  const files: DiffFile[] = [];
  for (let page = 1; files.length < MAX_PR_FILES; page++) {
    const { data } = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
      owner,
      repo: name,
      pull_number: number,
      per_page: 100,
      page,
    });
    files.push(...(data as RestFile[]).map(fromRestFile));
    if (data.length < 100) break;
  }
  return files;
}

/** A commit id as `?since=` takes it: 7 to 40 hex digits, so it can't name a branch or a range. */
export const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;

/**
 * The changes from `base` to `head`, a PR's head, when `base` is in its history: what's new since the head you
 * reviewed. Undefined when it isn't: GitHub no longer has `base`, or a force-push or rebase left it off the branch, so
 * "since" has no meaning and the caller shows the whole PR. One request to GitHub's compare API, whose file list stops
 * at 300 files. If the author merged the base branch in since, its changes are in the comparison too.
 */
export async function fetchCompareDiff(
  client: GitHubClient,
  repo: string,
  base: string,
  head: string,
): Promise<DiffFile[] | undefined> {
  if (!COMMIT_SHA.test(base) || !COMMIT_SHA.test(head)) return undefined;
  const [owner, name] = repo.split("/") as [string, string];
  let data: { status: string; files?: RestFile[] };
  try {
    ({ data } = (await client.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
      owner,
      repo: name,
      basehead: `${base}...${head}`,
    })) as { data: { status: string; files?: RestFile[] } });
  } catch (error) {
    // 404: GitHub doesn't know the commit (garbage-collected after a force-push); 422: no common history.
    const status = (error as { status?: number }).status;
    if (status === 404 || status === 422) return undefined;
    throw error;
  }
  // "ahead": head is base plus commits; "identical": nothing since. "diverged" or "behind": base isn't head's ancestor.
  if (data.status !== "ahead" && data.status !== "identical") return undefined;
  return (data.files ?? []).map(fromRestFile);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-c", "core.quotepath=off", ...args], { cwd, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

export interface LocalDiff {
  repoRoot: string;
  branch: string | null;
  files: DiffFile[];
}

async function isBinary(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(8000);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

async function untrackedFile(repoRoot: string, path: string): Promise<DiffFile> {
  const full = join(repoRoot, path);
  const base = { path, status: "added" as const, deletions: 0, patchMissing: false };
  if ((await stat(full)).size > MAX_UNTRACKED_BYTES) {
    return { ...base, additions: 0, binary: false, patchMissing: true, hunks: [] };
  }
  if (await isBinary(full)) return { ...base, additions: 0, binary: true, hunks: [] };

  const content = await readFile(full, "utf8");
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return {
    ...base,
    additions: lines.length,
    binary: false,
    hunks:
      lines.length === 0
        ? []
        : [
            {
              header: `@@ -0,0 +1,${lines.length} @@`,
              oldStart: 0,
              oldLines: 0,
              newStart: 1,
              newLines: lines.length,
              lines: lines.map((text, i) => ({ kind: "add" as const, text, newLine: i + 1 })),
            },
          ],
  };
}

/** Everything that differs from HEAD in the working tree: staged, unstaged and untracked (respecting .gitignore). */
export async function readLocalDiff(cwd: string = process.cwd()): Promise<LocalDiff> {
  let repoRoot: string;
  try {
    // git prints forward slashes on Windows; resolve() gives the platform's own form.
    repoRoot = resolve((await git(cwd, ["rev-parse", "--show-toplevel"])).trim());
  } catch {
    throw new Error("Not inside a git repository. Run `alden review` from your project, or pass a PR.");
  }
  try {
    await git(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    throw new Error("This repository has no commits yet, so there's nothing to compare against.");
  }

  const branch = (await git(repoRoot, ["branch", "--show-current"])).trim() || null;
  const tracked = parseUnifiedDiff(
    await git(repoRoot, [
      "diff",
      "HEAD",
      "-M",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      // Users' diff.noprefix or diff.mnemonicPrefix settings would otherwise change how paths appear.
      "--src-prefix=a/",
      "--dst-prefix=b/",
    ]),
  );
  const untrackedPaths = (await git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean);
  const untracked = await Promise.all(untrackedPaths.map((p) => untrackedFile(repoRoot, p)));

  return { repoRoot, branch, files: [...tracked, ...untracked] };
}
