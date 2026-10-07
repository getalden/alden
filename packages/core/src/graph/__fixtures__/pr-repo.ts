import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The repo the fixture stands in for on GitHub. */
export const REPO = "acme/app";
export const PR = 7;

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@e.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@e.com",
    },
  })
    .toString()
    .trim();

/**
 * A PR and its base moving on, as GitHub would hold them: `github` has `main`, `refs/pull/7/head` and (unless
 * `merge: false`) `refs/pull/7/merge`; `clone` is the user's clone, whose remote names GitHub but fetches from
 * `github` (through `insteadOf`, which `git remote -v` would show rewritten, so the raw URL is what's matched).
 *
 * The PR changes `rankQueue`'s signature at line 5 of src/rank.ts. After it branched, main put two comment lines at
 * the top of that file (so the merged file's lines no longer match the PR's diff) and added src/late.ts, a new caller.
 */
export async function prRepo(options: { merge?: boolean } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "alden-pr-")));
  const github = join(dir, "github");
  const clone = join(dir, "clone");
  await mkdir(join(github, "src"), { recursive: true });
  const write = (path: string, text: string) => writeFile(join(github, path), text);
  git(github, "init", "-q", "-b", "main");
  await write(
    "src/rank.ts",
    "export function helper() {\n  return 1;\n}\n\nexport function rankQueue(queue) {\n  return queue;\n}\n",
  );
  await write("src/cli.ts", 'import { rankQueue } from "./rank";\nrankQueue([]);\n');
  git(github, "add", ".");
  git(github, "commit", "-q", "-m", "init");
  const forkPoint = git(github, "rev-parse", "HEAD");

  git(github, "checkout", "-q", "-b", "pr");
  await write(
    "src/rank.ts",
    "export function helper() {\n  return 1;\n}\n\nexport function rankQueue(queue, now) {\n  return queue;\n}\n",
  );
  git(github, "commit", "-q", "-am", "now");
  const head = git(github, "rev-parse", "HEAD");

  git(github, "checkout", "-q", "main");
  await write(
    "src/rank.ts",
    "// Ranking.\n// More.\nexport function helper() {\n  return 1;\n}\n\nexport function rankQueue(queue) {\n  return queue;\n}\n",
  );
  await write("src/late.ts", 'import { rankQueue } from "./rank";\n\nexport const late = () => rankQueue([]);\n');
  git(github, "add", ".");
  git(github, "commit", "-q", "-m", "on main since");
  const base = git(github, "rev-parse", "HEAD");

  git(github, "update-ref", `refs/pull/${PR}/head`, head);
  let merge: string | undefined;
  if (options.merge !== false) {
    git(github, "checkout", "-q", "--detach", base);
    git(github, "merge", "-q", "--no-ff", "--no-edit", head);
    merge = git(github, "rev-parse", "HEAD");
    git(github, "update-ref", `refs/pull/${PR}/merge`, merge);
    git(github, "checkout", "-q", "main");
  }

  git(dir, "clone", "-q", github, clone);
  git(clone, "remote", "set-url", "origin", `https://github.com/${REPO}.git`);
  git(clone, "config", `url.${github}.insteadOf`, `https://github.com/${REPO}.git`);

  /** The PR's own diff, as GitHub's files API gives it: the head against where it branched. */
  const diff = git(github, "diff", forkPoint, head);
  return { dir, github, clone, forkPoint, head, base, merge, diff, // Windows can hold a git file a moment after the process exits: retry, and leave the rest to the OS.
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {}),
  };
}
