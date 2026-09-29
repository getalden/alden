import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXTRACTOR_VERSION, indexCachePath, indexRepo } from "./index-repo.js";

let repo: string;
let cacheDir: string;

const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@e.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@e.com",
    },
  });

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), "alden-index-")));
  cacheDir = await mkdtemp(join(tmpdir(), "alden-index-cache-"));
  git("init", "-q", "-b", "main");
  await mkdir(join(repo, "src"));
  await mkdir(join(repo, "dist"));
  await writeFile(join(repo, "src/a.ts"), "export function a() { return b(); }\n");
  await writeFile(join(repo, "src/b.ts"), "export function b() { return 1; }\n");
  await writeFile(join(repo, "src/app.py"), "def run():\n    return 1\n");
  await writeFile(join(repo, "README.md"), "# docs are not indexed\n");
  await writeFile(join(repo, "dist/bundle.js"), "function x() {}\n");
  await writeFile(join(repo, "src/lib.min.js"), "function y(){}\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
});

describe("indexRepo", () => {
  it("indexes covered languages and skips generated or vendored files", async () => {
    const index = await indexRepo(repo, { cacheDir });
    expect([...index.files.keys()].sort()).toEqual(["src/a.ts", "src/app.py", "src/b.ts"]);
    expect(index.skipped.sort()).toEqual(["dist/bundle.js", "src/lib.min.js"]);
    expect(index.files.get("src/a.ts")?.definitions[0]?.name).toBe("a");
    expect(index).toMatchObject({ complete: true, stats: { candidates: 5, parsed: 3, fromCache: 0 } });
  });

  it("reuses the cache, re-parsing only changed, untracked or newly staged content", async () => {
    await indexRepo(repo, { cacheDir });
    expect((await indexRepo(repo, { cacheDir })).stats).toMatchObject({ parsed: 0, fromCache: 3 });

    await writeFile(join(repo, "src/b.ts"), "export function b(x: number) { return x; }\n"); // modified, unstaged
    await writeFile(join(repo, "src/c.ts"), "export const c = () => 1;\n"); // untracked
    const next = await indexRepo(repo, { cacheDir });
    expect(next.stats).toMatchObject({ parsed: 2, fromCache: 2 });
    expect(next.files.get("src/b.ts")?.definitions[0]).toMatchObject({ name: "b" });
    expect(next.files.has("src/c.ts")).toBe(true);

    // Staging b.ts switches its key from a content hash to the blob hash, so it is parsed once more; the rest stay cached.
    git("add", "src/b.ts");
    expect((await indexRepo(repo, { cacheDir })).stats).toMatchObject({ parsed: 1, fromCache: 3 });
  });

  it("leaves out files deleted in the working tree", async () => {
    await rm(join(repo, "src/b.ts"));
    const index = await indexRepo(repo, { cacheDir });
    expect(index.files.has("src/b.ts")).toBe(false);
    expect(index.skipped).not.toContain("src/b.ts");
  });

  it("stops at the time budget and says the index is incomplete", async () => {
    let clock = 0;
    const index = await indexRepo(repo, { cacheDir, budgetMs: 5, now: () => (clock += 10) });
    expect(index.complete).toBe(false);
    expect(index.files.size).toBeLessThan(3);
  });

  it("drops a cache written by a different extractor version", async () => {
    await indexRepo(repo, { cacheDir });
    const path = indexCachePath(repo, cacheDir);
    const cache = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...cache, version: EXTRACTOR_VERSION + 99 }));
    expect((await indexRepo(repo, { cacheDir })).stats).toMatchObject({ parsed: 3, fromCache: 0 });
  });
});
