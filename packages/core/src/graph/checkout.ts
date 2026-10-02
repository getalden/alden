import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { aldenHome } from "../config.js";

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  return stdout.trim();
}

/** "owner/name" from a GitHub remote URL in any of its forms (https, ssh, git@). */
export function repoFromRemote(url: string): string | undefined {
  const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined;
}

export type Checkout = { ok: true; root: string } | { ok: false; reason: string };

/**
 * A checkout of a PR's head, for the code graph. Needs `cwd` to be inside a clone of the PR's repo (any remote may
 * point at it, e.g. a fork's upstream). Fetches the PR into `refs/alden/pr-<n>` and checks it out, detached, in one
 * reusable worktree per repo under ~/.alden/worktrees. The user's own working tree is never touched.
 */
export async function checkoutPullRequest(
  cwd: string,
  repo: string,
  number: number,
  worktrees: string = join(aldenHome(), "worktrees"),
): Promise<Checkout> {
  let root: string;
  try {
    root = resolve(await git(cwd, ["rev-parse", "--show-toplevel"]));
  } catch {
    return { ok: false, reason: `Run \`alden review\` from a clone of ${repo} to check callers outside the diff.` };
  }

  const remotes = (await git(root, ["remote", "-v"])).split("\n");
  const remote = remotes
    .map((line) => line.split(/\s+/))
    .find(([, url]) => url !== undefined && repoFromRemote(url) === repo.toLowerCase())?.[0];
  if (!remote) {
    return {
      ok: false,
      reason: `This clone has no remote for ${repo}, so callers outside the diff weren't checked. Run from a clone of ${repo}.`,
    };
  }

  const ref = `refs/alden/pr-${number}`;
  const worktree = join(worktrees, createHash("sha256").update(root).digest("hex").slice(0, 16));
  try {
    await git(root, ["fetch", "--quiet", "--no-tags", remote, `+pull/${number}/head:${ref}`]);
    if (!existsSync(join(worktree, ".git"))) {
      await mkdir(worktrees, { recursive: true });
      // A worktree left over from a deleted directory would block `add`.
      await git(root, ["worktree", "prune"]);
      await git(root, ["worktree", "add", "--detach", "--quiet", worktree, ref]);
    } else {
      await git(worktree, ["checkout", "--detach", "--quiet", "--force", ref]);
    }
  } catch (error) {
    const message = (error as { stderr?: string }).stderr?.trim().split("\n").at(-1) ?? (error as Error).message;
    return { ok: false, reason: `Couldn't fetch ${repo}#${number} for the code graph (${message}).` };
  }
  return { ok: true, root: worktree };
}

let checkoutQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs `work` once every earlier call has finished. PR checkouts share one worktree per clone, so a PR's code graph
 * must be read before the next PR is checked out there: the UI can run briefings side by side, and the desktop app
 * prepares them in the background. (Separate processes, such as the CLI next to the app, aren't covered.)
 */
export function withCheckoutLock<T>(work: () => Promise<T>): Promise<T> {
  const next = checkoutQueue.then(work, work);
  checkoutQueue = next.catch(() => {});
  return next;
}
