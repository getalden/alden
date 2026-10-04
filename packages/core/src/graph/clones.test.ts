import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeStores, openStore } from "../store/db.js";
import { clonesUnder, expandHome, findClone, noteClone, rememberClone, rememberedClone } from "./clones.js";

let dir: string;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

/** A clone at `path` with an origin for `repo`. */
async function clone(path: string, repo?: string) {
  await mkdir(path, { recursive: true });
  git(path, "init", "-q");
  if (repo) git(path, "remote", "add", "origin", `git@github.com:${repo}.git`);
  return path;
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "alden-clones-")));
  process.env.ALDEN_HOME = join(dir, "home");
});

afterEach(async () => {
  closeStores();
  delete process.env.ALDEN_HOME;
  await rm(dir, { recursive: true, force: true });
});

describe("clones", () => {
  it("remembers the clone Alden runs in, and finds it from anywhere", async () => {
    const laravel = await clone(join(dir, "src/laravel"), "Acme/Laravel-App");
    await noteClone(laravel);
    expect(rememberedClone("acme/laravel-app")).toBe(laravel);
    const elsewhere = await mkdir(join(dir, "sandbox"), { recursive: true }).then(() => join(dir, "sandbox"));
    expect(await findClone("acme/laravel-app", { cwd: elsewhere })).toEqual({ path: laravel, how: "remembered" });
  });

  it("prefers the clone it runs in", async () => {
    const here = await clone(join(dir, "here"), "a/b");
    rememberClone("a/b", join(dir, "gone"));
    expect(await findClone("a/b", { cwd: here })).toEqual({ path: here, how: "here" });
  });

  it("forgets a remembered clone that moved or lost its remote", async () => {
    const moved = await clone(join(dir, "old"), "a/b");
    rememberClone("a/b", moved);
    git(moved, "remote", "set-url", "origin", "git@github.com:other/repo.git");
    expect(await findClone("a/b", { cwd: dir })).toBeUndefined();
    expect(rememberedClone("a/b")).toBeUndefined();
    rememberClone("a/b", join(dir, "deleted"));
    expect(await findClone("a/b", { cwd: dir })).toBeUndefined();
  });

  it("searches clones.folders a few levels down, and remembers what it found", async () => {
    await clone(join(dir, "src/one"), "a/one");
    const deep = await clone(join(dir, "src/github.com/acme/shop"), "acme/shop");
    await clone(join(dir, "src/no-remote"));
    expect((await clonesUnder(join(dir, "src"))).map((c) => c.repos[0]).sort()).toEqual(["a/one", "acme/shop"]);
    expect(await findClone("acme/shop", { cwd: dir, folders: [join(dir, "src")] })).toEqual({
      path: deep,
      how: "folders",
    });
    expect(rememberedClone("a/one")).toBe(join(dir, "src/one"));
    expect(await findClone("x/y", { cwd: dir, folders: [join(dir, "src")] })).toBeUndefined();
  });

  it("expands ~ in folders", () => {
    expect(expandHome("~/src")).not.toContain("~");
    expect(expandHome("/abs")).toBe(resolve("/abs"));
  });

  it("keeps clones in the store's meta table", async () => {
    rememberClone("a/b", "/x");
    expect(openStore().get<{ value: string }>("SELECT value FROM meta WHERE key = 'clone:a/b'")?.value).toBe(
      resolve("/x"),
    );
  });
});
