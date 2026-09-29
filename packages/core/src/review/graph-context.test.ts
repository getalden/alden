import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AldenConfigSchema } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkoutPullRequest, repoFromRemote } from "../graph/checkout.js";
import { reviewLocalChanges } from "./run.js";

let repo: string;
let home: string;
const config = AldenConfigSchema.parse({});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@e.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@e.com",
    },
  });

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), "alden-graph-review-")));
  home = await mkdtemp(join(tmpdir(), "alden-graph-home-"));
  process.env.ALDEN_HOME = home;
  git(repo, "init", "-q", "-b", "main");
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "src/rank.ts"), "export function rankQueue(queue) {\n  return queue;\n}\n");
  await writeFile(join(repo, "src/cli.ts"), 'import { rankQueue } from "./rank";\nrankQueue([]);\n');
  await writeFile(join(repo, "src/other.go"), "package main\n\nfunc main() {}\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
});

afterEach(async () => {
  delete process.env.ALDEN_HOME;
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("local review with the code graph", () => {
  it("flags a re-signed function's callers and says what the graph couldn't cover", async () => {
    await writeFile(join(repo, "src/rank.ts"), "export function rankQueue(queue, now) {\n  return queue;\n}\n");
    await writeFile(join(repo, "src/other.go"), "package main\n\nfunc main() { println(1) }\n");
    const briefing = await reviewLocalChanges(config, repo);

    const callers = briefing.checks.find((c) => c.id === "callers.outside");
    expect(callers).toMatchObject({ status: "flagged", severity: "high" });
    expect(callers?.evidence[0]).toEqual({
      text: "calls rankQueue (signature changed)",
      anchor: { path: "src/cli.ts", line: 2 },
    });
    expect(briefing.needsYourEyes.some((i) => i.anchor?.path === "src/cli.ts")).toBe(true);
    expect(briefing.notChecked).toContain("Callers of changes in src/other.go (Go and PHP support is coming)");
    expect(briefing.notChecked.some((n) => n.startsWith("Callers and code outside the diff"))).toBe(false);
  });

  it("can be switched off", async () => {
    await writeFile(join(repo, "src/rank.ts"), "export function rankQueue(queue, now) {\n  return queue;\n}\n");
    const briefing = await reviewLocalChanges(config, repo, undefined, { enabled: false });
    expect(briefing.checks.find((c) => c.id === "callers.outside")?.status).toBe("skipped");
  });
});

describe("checkoutPullRequest", () => {
  it("reads owner/name from GitHub remotes in every form", () => {
    for (const url of [
      "https://github.com/getalden/alden.git",
      "https://github.com/getalden/alden",
      "git@github.com:getalden/alden.git",
      "ssh://git@github.com/getalden/alden.git",
    ]) {
      expect(repoFromRemote(url)).toBe("getalden/alden");
    }
    expect(repoFromRemote("https://gitlab.com/a/b.git")).toBeUndefined();
  });

  it("explains when it isn't run from a clone of the PR's repo", async () => {
    const outside = await mkdtemp(join(tmpdir(), "alden-not-a-repo-"));
    try {
      expect(await checkoutPullRequest(outside, "a/b", 1)).toEqual({
        ok: false,
        reason: expect.stringMatching(/from a clone of a\/b/),
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    git(repo, "remote", "add", "origin", "https://github.com/someone/else.git");
    expect(await checkoutPullRequest(repo, "getalden/alden", 1)).toEqual({
      ok: false,
      reason: expect.stringMatching(/no remote for getalden\/alden/),
    });
  });
});
