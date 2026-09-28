import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLocalDiff } from "./sources.js";

let repo: string;

const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), "alden-local-")));
  git("init", "-q", "-b", "main");
  git("config", "core.autocrlf", "false");
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "src/app.ts"), "export const a = 1;\nexport const b = 2;\n");
  await writeFile(join(repo, "src/old.ts"), "export function old() {}\n".repeat(5));
  await writeFile(join(repo, "gone.md"), "bye\n");
  await writeFile(join(repo, ".gitignore"), "ignored.log\n");
  git("add", ".");
  git("commit", "-q", "-m", "initial");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("readLocalDiff", () => {
  it("collects staged, unstaged, renamed, deleted and untracked changes, skipping ignored files", async () => {
    await writeFile(join(repo, "src/app.ts"), "export const a = 1;\nexport const b = 3;\n"); // unstaged
    await rename(join(repo, "src/old.ts"), join(repo, "src/renamed.ts"));
    git("add", "-A", "src/old.ts", "src/renamed.ts"); // staged rename
    await rm(join(repo, "gone.md"));
    await writeFile(join(repo, "src/new.ts"), "export const c = 4;\nexport const d = 5;\n"); // untracked
    await writeFile(join(repo, "ignored.log"), "noise\n");

    const diff = await readLocalDiff(join(repo, "src"));
    expect(await realpath(diff.repoRoot)).toBe(repo);
    expect(diff.branch).toBe("main");

    const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(["gone.md", "src/app.ts", "src/new.ts", "src/renamed.ts"]);
    expect(byPath["src/app.ts"]).toMatchObject({ status: "modified", additions: 1, deletions: 1 });
    expect(byPath["src/renamed.ts"]).toMatchObject({ status: "renamed", previousPath: "src/old.ts" });
    expect(byPath["gone.md"]).toMatchObject({ status: "removed", deletions: 1 });
    expect(byPath["src/new.ts"]).toMatchObject({ status: "added", additions: 2 });
    expect(byPath["src/new.ts"]?.hunks[0]?.lines[1]).toEqual({ kind: "add", text: "export const d = 5;", newLine: 2 });
  });

  it("marks untracked binary files", async () => {
    await writeFile(join(repo, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const diff = await readLocalDiff(repo);
    expect(diff.files.find((f) => f.path === "image.bin")).toMatchObject({ binary: true, hunks: [] });
  });

  it("ignores the user's diff prefix settings", async () => {
    git("config", "diff.noprefix", "true");
    await writeFile(join(repo, "src/app.ts"), "changed\n");
    const diff = await readLocalDiff(repo);
    expect(diff.files.map((f) => f.path)).toEqual(["src/app.ts"]);
  });

  it("returns nothing for a clean tree", async () => {
    expect((await readLocalDiff(repo)).files).toEqual([]);
  });

  it("explains when it isn't in a repository", async () => {
    const outside = await mkdtemp(join(tmpdir(), "alden-norepo-"));
    try {
      await expect(readLocalDiff(outside)).rejects.toThrow(/Not inside a git repository/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
