import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DiffFile } from "../diff/parse.js";
import type { GitHubClient } from "../github/client.js";
import { isManifest, type ManifestSnapshot } from "./dependencies.js";

const run = promisify(execFile);

/**
 * Rebuilds the old version of a file from its new version and the diff between them. Lets Alden read a PR's
 * manifest "before" exactly as GitHub's diff sees it, without chasing the merge base.
 */
export function reverseApply(after: string, file: DiffFile): string {
  const newLines = after === "" ? [] : after.split("\n");
  const out: string[] = [];
  let cursor = 1; // next line of the new file to copy, 1-based

  for (const hunk of file.hunks) {
    // A hunk that only deletes reports the new-file line *before* the deletion.
    const firstNewLine = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
    while (cursor < firstNewLine && cursor <= newLines.length) out.push(newLines[cursor++ - 1] as string);
    for (const line of hunk.lines) {
      if (line.kind === "context") {
        out.push(line.text);
        cursor++;
      } else if (line.kind === "del") {
        out.push(line.text);
      } else {
        cursor++;
      }
    }
  }
  while (cursor <= newLines.length) out.push(newLines[cursor++ - 1] as string);
  return out.join("\n");
}

const changedManifests = (files: DiffFile[]) => files.filter((f) => isManifest(f.path) && !f.binary);

/** Both sides of each changed manifest in the working tree, against HEAD. */
export async function loadLocalManifests(repoRoot: string, files: DiffFile[]): Promise<ManifestSnapshot[]> {
  return Promise.all(
    changedManifests(files).map(async (file) => {
      const snapshot: ManifestSnapshot = { path: file.path };
      if (file.status !== "added") {
        const { stdout } = await run("git", ["show", `HEAD:${file.previousPath ?? file.path}`], {
          cwd: repoRoot,
          maxBuffer: 64 * 1024 * 1024,
        });
        snapshot.before = stdout;
      }
      if (file.status !== "removed") snapshot.after = await readFile(join(repoRoot, file.path), "utf8");
      return snapshot;
    }),
  );
}

/**
 * Both sides of each changed manifest in a PR: the new version from the PR's head, the old one rebuilt from the diff.
 * Manifests whose diff GitHub didn't send are left out, and the dependency check reports them unread.
 */
export async function loadPullRequestManifests(
  client: GitHubClient,
  repo: string,
  number: number,
  files: DiffFile[],
): Promise<ManifestSnapshot[]> {
  const [owner, name] = repo.split("/") as [string, string];
  const readable = changedManifests(files).filter((f) => !f.patchMissing);
  return Promise.all(
    readable.map(async (file) => {
      let after = "";
      if (file.status !== "removed") {
        const { data } = await client.request("GET /repos/{owner}/{repo}/contents/{path}", {
          owner,
          repo: name,
          path: file.path,
          ref: `refs/pull/${number}/head`,
          headers: { accept: "application/vnd.github.raw+json" },
        });
        after = String(data);
      }
      const snapshot: ManifestSnapshot = { path: file.path };
      if (file.status !== "added") snapshot.before = reverseApply(after, file);
      if (file.status !== "removed") snapshot.after = after;
      return snapshot;
    }),
  );
}
