import { existsSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, PR, prRepo, REPO } from "./__fixtures__/pr-repo.js";
import { type CheckoutOptions, checkoutPullRequest, withCheckoutLock } from "./checkout.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withCheckoutLock", () => {
  it("runs one piece of work at a time, in order, even when one fails", async () => {
    const log: string[] = [];
    const job = (name: string, ms: number, fail = false) =>
      withCheckoutLock(async () => {
        log.push(`start ${name}`);
        await tick(ms);
        log.push(`end ${name}`);
        if (fail) throw new Error(name);
        return name;
      });
    const results = await Promise.allSettled([job("a", 20), job("b", 5, true), job("c", 1)]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});

describe("checkoutPullRequest against GitHub's merge", () => {
  let fixture: Awaited<ReturnType<typeof prRepo>>;
  let worktrees: string;
  afterEach(() => fixture.cleanup());
  const checkout = (options: CheckoutOptions = {}) =>
    checkoutPullRequest(fixture.clone, REPO, PR, { worktrees, baseRef: "main", ...options });
  const read = (root: string, path: string) => readFile(join(root, path), "utf8");

  it("checks out the merge, so code merged into the base since is there, with the PR's files at its head", async () => {
    fixture = await prRepo();
    worktrees = join(fixture.dir, "worktrees");
    const result = await checkout({ pin: ["src/rank.ts"] });
    expect(result).toEqual({
      ok: true,
      root: expect.any(String),
      graphFrom: "merge",
      headSha: fixture.head,
      baseSha: fixture.base,
    });
    if (!result.ok) return;
    expect(await read(result.root, "src/late.ts")).toContain("rankQueue([])");
    // The PR's diff numbers lines in its head's version: main's comment lines above would shift them.
    expect(await read(result.root, "src/rank.ts")).toMatch(/^export function helper/);
    expect(git(result.root, "rev-parse", "HEAD")).toBe(fixture.merge);
  });

  it("doesn't fetch when GitHub reports what's already fetched", async () => {
    fixture = await prRepo();
    worktrees = join(fixture.dir, "worktrees");
    const known = { headSha: fixture.head, mergeSha: fixture.merge ?? "", mergeable: "MERGEABLE" as const };
    expect(await checkout(known)).toMatchObject({ ok: true, graphFrom: "merge" });
    // With GitHub out of reach, only a fetch could fail.
    await rename(fixture.github, `${fixture.github}-gone`);
    expect(await checkout(known)).toMatchObject({ ok: true, graphFrom: "merge", baseSha: fixture.base });
    expect(await checkout({ ...known, headSha: "f".repeat(40) })).toMatchObject({ ok: false });
  });

  it("falls back to the PR's branch, and says so, when GitHub has no merge", async () => {
    fixture = await prRepo({ merge: false });
    worktrees = join(fixture.dir, "worktrees");
    const result = await checkout();
    expect(result).toEqual({
      ok: true,
      root: expect.any(String),
      graphFrom: "head",
      headSha: fixture.head,
      note: "Callers from the PR's branch: GitHub hasn't merged it with main yet, so changes merged since aren't included.",
    });
    if (!result.ok) return;
    expect(existsSync(join(result.root, "src/late.ts"))).toBe(false);
  });

  it("uses the PR's branch when it conflicts, without asking for a merge", async () => {
    fixture = await prRepo();
    worktrees = join(fixture.dir, "worktrees");
    // A merge left over from before the conflict isn't used.
    expect(await checkout({ headSha: fixture.head, mergeSha: fixture.merge ?? "" })).toMatchObject({
      graphFrom: "merge",
    });
    expect(await checkout({ headSha: fixture.head, mergeable: "CONFLICTING" })).toEqual({
      ok: true,
      root: expect.any(String),
      graphFrom: "head",
      headSha: fixture.head,
      note: "Callers from the PR's branch: it conflicts with main, so changes merged since aren't included.",
    });
  });

  it("doesn't use a merge GitHub made for an older push", async () => {
    fixture = await prRepo();
    worktrees = join(fixture.dir, "worktrees");
    git(fixture.github, "checkout", "-q", "pr");
    git(fixture.github, "commit", "-q", "--allow-empty", "-m", "newer push");
    const newer = git(fixture.github, "rev-parse", "HEAD");
    git(fixture.github, "update-ref", `refs/pull/${PR}/head`, newer);
    expect(await checkout()).toMatchObject({ ok: true, graphFrom: "head", headSha: newer });
  });
});
