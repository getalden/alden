import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../diff/parse.js";
import { readLocalDiff } from "../diff/sources.js";
import { loadLocalManifests, reverseApply } from "./manifests.js";

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "alden-manifests-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The diff git itself produces between two versions of a file. */
async function gitDiff(before: string, after: string) {
  await writeFile(join(dir, "a.json"), before);
  await writeFile(join(dir, "b.json"), after);
  // --no-index exits 1 when the files differ, so read stdout rather than treating that as an error.
  const { stdout } = spawnSync("git", ["diff", "--no-index", "--no-color", "a.json", "b.json"], {
    cwd: dir,
    encoding: "utf8",
  });
  const [file] = parseUnifiedDiff(stdout);
  if (!file) throw new Error("git produced no diff");
  return file;
}

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

describe("reverseApply", () => {
  const base = lines(40);
  it.each([
    ["an edit in the middle", base, base.map((l, i) => (i === 20 ? "changed" : l))],
    ["an insertion at the top", base, ["new first", ...base]],
    ["a deletion at the end", base, base.slice(0, 35)],
    ["a deletion at the top", base, base.slice(3)],
    ["edits far apart (two hunks)", base, base.map((l, i) => (i === 2 || i === 37 ? `${l} edited` : l))],
    ["a block replaced", base, [...base.slice(0, 10), "x", "y", ...base.slice(18)]],
    ["everything replaced", lines(5, "old"), lines(3, "new")],
  ])("rebuilds the original after %s", async (_label, before, after) => {
    const beforeText = `${before.join("\n")}\n`;
    const afterText = `${after.join("\n")}\n`;
    const file = await gitDiff(beforeText, afterText);
    expect(reverseApply(afterText, file)).toBe(beforeText);
  });
});

describe("loadLocalManifests", () => {
  it("reads HEAD and the working tree for changed, added and removed manifests only", async () => {
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "T",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "T",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      });
    git("init", "-q", "-b", "main");
    await writeFile(join(dir, "package.json"), '{"dependencies":{"react":"^18.2.0"}}\n');
    await writeFile(join(dir, "composer.json"), '{"require":{"laravel/framework":"^12.0"}}\n');
    await writeFile(join(dir, "app.ts"), "export {};\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    await writeFile(join(dir, "package.json"), '{"dependencies":{"react":"^19.0.0"}}\n');
    await rm(join(dir, "composer.json"));
    await writeFile(join(dir, "go.mod"), "module x\nrequire github.com/spf13/cobra v1.9.1\n");
    await writeFile(join(dir, "app.ts"), "export const a = 1;\n");

    const { repoRoot, files } = await readLocalDiff(dir);
    const snapshots = await loadLocalManifests(repoRoot, files);
    const byPath = Object.fromEntries(snapshots.map((s) => [s.path, s]));

    expect(Object.keys(byPath).sort()).toEqual(["composer.json", "go.mod", "package.json"]);
    expect(byPath["package.json"]).toEqual({
      path: "package.json",
      before: '{"dependencies":{"react":"^18.2.0"}}\n',
      after: '{"dependencies":{"react":"^19.0.0"}}\n',
    });
    expect(byPath["composer.json"]?.after).toBeUndefined();
    expect(byPath["go.mod"]?.before).toBeUndefined();
  });
});
