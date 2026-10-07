import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PrDiff, PrDiffFile } from "@alden/schema";
import type { GitHubClient } from "../github/client.js";
import { fetchPullRequestState } from "../review/drafts.js";
import type { DiffFile } from "./parse.js";
import { readLocalDiff } from "./sources.js";

const run = promisify(execFile);

/** One changed file as the Diff tab shows it: "context" lines become "ctx", and counts and notices ride along. */
export function toDiffViewFile(file: DiffFile): PrDiffFile {
  return {
    path: file.path,
    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    ...(file.binary ? { binary: true } : {}),
    ...(file.patchMissing ? { patchMissing: true } : {}),
    hunks: file.patchMissing
      ? []
      : file.hunks.map((h) => ({
          header: h.header,
          lines: h.lines.map((l) => ({
            kind: l.kind === "context" ? ("ctx" as const) : l.kind,
            ...(l.oldLine !== undefined ? { oldLine: l.oldLine } : {}),
            ...(l.newLine !== undefined ? { newLine: l.newLine } : {}),
            text: l.text,
          })),
        })),
  };
}

export function toDiffView(headSha: string, files: DiffFile[]): PrDiff {
  return { headSha, files: files.map(toDiffViewFile) };
}

/**
 * Diffs already fetched, by PR and head commit, so opening the Diff tab again (or another window on the same PR) costs
 * one request for the head instead of every file's patch. A push changes the head, so a stale diff is never served.
 * Small: a few recent PRs.
 */
export class DiffCache {
  private readonly entries = new Map<string, PrDiff>();

  constructor(private readonly limit = 8) {}

  private key(repo: string, number: number, headSha: string): string {
    return `${repo.toLowerCase()}#${number}@${headSha}`;
  }

  get(repo: string, number: number, headSha: string): PrDiff | undefined {
    const key = this.key(repo, number, headSha);
    const hit = this.entries.get(key);
    if (hit) {
      // Most recently used goes last; the first is evicted.
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(repo: string, number: number, diff: PrDiff): void {
    const key = this.key(repo, number, diff.headSha);
    this.entries.delete(key);
    this.entries.set(key, diff);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/** A PR's diff at its current head: one request for the head, then the files API only when it isn't cached. */
export async function pullRequestDiffView(
  client: GitHubClient,
  repo: string,
  number: number,
  cache: DiffCache,
): Promise<PrDiff> {
  const [owner, name] = repo.split("/") as [string, string];
  const { data } = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo: name,
    pull_number: number,
  });
  const head = (data as { head: { sha: string } }).head.sha;
  const cached = cache.get(repo, number, head);
  if (cached) return cached;
  // Re-reads the head after the files, so a push in between can't pair new files with an old head.
  const state = await fetchPullRequestState(client, repo, number);
  const diff = toDiffView(state.headSha, state.files);
  cache.set(repo, number, diff);
  return diff;
}

/**
 * The local changes a briefing of them covers: everything that differs from HEAD, untracked files included. Not
 * cached, since the working tree changes without a new commit; `headSha` is HEAD's.
 */
export async function localDiffView(cwd: string): Promise<PrDiff> {
  const { repoRoot, files } = await readLocalDiff(cwd);
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  return toDiffView(stdout.trim(), files);
}
