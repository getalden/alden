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

/** Where a PR's code graph came from: GitHub's merge of the PR onto its latest base, or the PR's own branch. */
export type GraphFrom = "merge" | "head";

export type Checkout =
  | {
      ok: true;
      root: string;
      graphFrom: GraphFrom;
      /** The PR head commit checked out (or, for a merge, whose versions of the PR's files were kept). */
      headSha: string;
      /** The base commit the graph saw: the merge's first parent. Absent for a checkout of the PR's branch. */
      baseSha?: string;
      /** Why the graph comes from the PR's branch rather than the merge, in a sentence for the briefing. */
      note?: string;
    }
  | { ok: false; reason: string };

export interface CheckoutOptions {
  /** Defaults to ~/.alden/worktrees. */
  worktrees?: string;
  /** The base branch's name, for the note when the merge can't be used. */
  baseRef?: string;
  /** What GitHub says now: the PR's head, its merge commit (`refs/pull/N/merge`) and whether it merges cleanly. */
  headSha?: string;
  mergeSha?: string;
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /**
   * The PR's changed paths (new paths). In a merge checkout they're put back to the PR head's version, so line numbers
   * match the PR's own diff even where the base changed the same file since.
   */
  pin?: string[];
}

/**
 * A checkout of a PR for the code graph: GitHub's `refs/pull/N/merge`, the PR merged onto its latest base (what CI
 * tests), so callers added or moved on the base since the PR branched are found. When there's no merge (the PR
 * conflicts, or GitHub hasn't made one for its latest push), the PR's head, with a note saying so.
 *
 * Needs `cwd` to be inside a clone of the PR's repo (any remote may point at it, e.g. a fork's upstream). Fetches into
 * `refs/alden/pr-<n>` and `refs/alden/pr-<n>-merge`, skipping the fetch when those already hold what GitHub reports,
 * and checks out, detached, in one reusable worktree per repo under ~/.alden/worktrees. The user's own working tree is
 * never touched.
 */
export async function checkoutPullRequest(
  cwd: string,
  repo: string,
  number: number,
  options: CheckoutOptions = {},
): Promise<Checkout> {
  const worktrees = options.worktrees ?? join(aldenHome(), "worktrees");
  let root: string;
  try {
    root = resolve(await git(cwd, ["rev-parse", "--show-toplevel"]));
  } catch {
    return { ok: false, reason: `Run \`alden review\` from a clone of ${repo} to check callers outside the diff.` };
  }

  // The URLs as configured, not as `insteadOf` rewrites them: the clone names GitHub even when it fetches elsewhere.
  const remotes = (await git(root, ["config", "--get-regexp", "^remote\\..*\\.url$"]).catch(() => "")).split("\n");
  const remote = remotes
    .map((line) => /^remote\.(.+)\.url\s+(.*)$/.exec(line))
    .find((match) => match?.[2] !== undefined && repoFromRemote(match[2]) === repo.toLowerCase())?.[1];
  if (!remote) {
    return {
      ok: false,
      reason: `This clone has no remote for ${repo}, so callers outside the diff weren't checked. Run from a clone of ${repo}.`,
    };
  }

  const headRef = `refs/alden/pr-${number}`;
  const mergeRef = `refs/alden/pr-${number}-merge`;
  const base = options.baseRef ?? "the base branch";
  const worktree = join(worktrees, createHash("sha256").update(root).digest("hex").slice(0, 16));
  // Told what GitHub has, a PR with no merge commit isn't asked for one.
  const wantMerge = options.mergeable !== "CONFLICTING" && (options.headSha === undefined || !!options.mergeSha);
  const note =
    options.mergeable === "CONFLICTING"
      ? `Callers from the PR's branch: it conflicts with ${base}, so changes merged since aren't included.`
      : `Callers from the PR's branch: GitHub hasn't merged it with ${base} yet, so changes merged since aren't included.`;
  let from: GraphFrom = "head";
  let baseSha: string | undefined;
  let headSha: string;
  try {
    const [haveHead, haveMerge] = await Promise.all([commitOf(root, headRef), commitOf(root, mergeRef)]);
    const current =
      options.headSha !== undefined &&
      haveHead === options.headSha &&
      (!wantMerge || (options.mergeSha !== undefined && haveMerge === options.mergeSha));
    let mergeFetched = wantMerge && haveMerge !== undefined;
    if (!current) {
      const fetch = (...specs: string[]) => git(root, ["fetch", "--quiet", "--no-tags", remote, ...specs]);
      if (!wantMerge) await fetch(`+pull/${number}/head:${headRef}`);
      else {
        try {
          await fetch(`+pull/${number}/head:${headRef}`, `+pull/${number}/merge:${mergeRef}`);
          mergeFetched = true;
        } catch (error) {
          if (!/couldn't find remote ref/i.test((error as { stderr?: string }).stderr ?? "")) throw error;
          // No merge on GitHub: conflicts, or not computed yet. Don't let an old one stand in for it.
          await git(root, ["update-ref", "-d", mergeRef]).catch(() => {});
          await fetch(`+pull/${number}/head:${headRef}`);
          mergeFetched = false;
        }
      }
    }
    headSha = await git(root, ["rev-parse", "--verify", `${headRef}^{commit}`]);
    if (wantMerge && mergeFetched) {
      // "<merge> <base> <head>": a merge of an older push doesn't hold the PR's latest code.
      const [, first, second] = (await git(root, ["rev-list", "--parents", "-n", "1", mergeRef])).split(" ");
      if (second === headSha && first) {
        from = "merge";
        baseSha = first;
      }
    }

    const target = from === "merge" ? mergeRef : headRef;
    if (!existsSync(join(worktree, ".git"))) {
      await mkdir(worktrees, { recursive: true });
      // A worktree left over from a deleted directory would block `add`.
      await git(root, ["worktree", "prune"]);
      await git(root, ["worktree", "add", "--detach", "--quiet", worktree, target]);
    } else {
      await git(worktree, ["checkout", "--detach", "--quiet", "--force", target]);
    }
    if (from === "merge" && options.pin && options.pin.length > 0)
      await pinToHead(worktree, mergeRef, headRef, options.pin);
  } catch (error) {
    const message = (error as { stderr?: string }).stderr?.trim().split("\n").at(-1) ?? (error as Error).message;
    return { ok: false, reason: `Couldn't fetch ${repo}#${number} for the code graph (${message}).` };
  }
  return {
    ok: true,
    root: worktree,
    graphFrom: from,
    headSha,
    ...(baseSha ? { baseSha } : {}),
    ...(from === "head" ? { note } : {}),
  };
}

/** The commit a ref points at, or undefined when there's no such ref. */
async function commitOf(root: string, ref: string): Promise<string | undefined> {
  return git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => undefined);
}

/**
 * Puts the PR's own files back to the PR head's version in a merge checkout. The PR's diff (head against where it
 * branched) says which lines changed; where the base changed the same file since, the merged file's lines no longer
 * match it. Only files that differ are touched, and the next checkout's `--force` discards them.
 */
async function pinToHead(worktree: string, mergeRef: string, headRef: string, paths: string[]): Promise<void> {
  const literal = ["--literal-pathspecs"];
  const differ = (
    await git(worktree, [
      ...literal,
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--diff-filter=AMT",
      mergeRef,
      headRef,
      "--",
      ...paths,
    ])
  )
    .split("\0")
    .filter(Boolean);
  if (differ.length > 0) await git(worktree, [...literal, "checkout", headRef, "--", ...differ]);
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
