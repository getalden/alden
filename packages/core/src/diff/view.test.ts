import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrDiffSchema } from "@alden/schema";
import { describe, expect, it } from "vitest";
import type { GitHubClient } from "../github/client.js";
import { fromRestFile } from "./sources.js";
import { DiffCache, localDiffView, pullRequestDiffView, toDiffView } from "./view.js";

const DIFFS = join(import.meta.dirname, "../github/__fixtures__/diffs");
type RestFile = Parameters<typeof fromRestFile>[0];
const recorded = (name: string) => JSON.parse(readFileSync(join(DIFFS, name), "utf8")) as RestFile[];

/** A GitHub client that answers the PR and files endpoints from a recorded diff, and counts what it was asked. */
function fakeClient(files: RestFile[], heads: string[]) {
  const calls: string[] = [];
  let headIndex = 0;
  const client = {
    async request(route: string, params: { page?: number }) {
      calls.push(route);
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        const sha = heads[Math.min(headIndex++, heads.length - 1)];
        return { data: { head: { sha } } };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
        const page = params.page ?? 1;
        return { data: files.slice((page - 1) * 100, page * 100) };
      }
      throw new Error(`unexpected ${route}`);
    },
  } as unknown as GitHubClient;
  return { client, calls };
}

describe("toDiffView on every recorded diff", () => {
  const names = readdirSync(DIFFS).filter((f) => f.endsWith(".json"));

  it.each(names)("%s matches the schema, with line numbers that count up", (name) => {
    const diff = toDiffView("abc123", recorded(name).map(fromRestFile));
    expect(PrDiffSchema.safeParse(diff).success).toBe(true);
    for (const file of diff.files) {
      for (const hunk of file.hunks) {
        expect(hunk.header.startsWith("@@")).toBe(true);
        const news = hunk.lines.flatMap((l) => (l.newLine === undefined ? [] : [l.newLine]));
        expect(news).toEqual([...news].sort((a, b) => a - b));
        for (const line of hunk.lines) {
          if (line.kind === "add") expect(line.oldLine).toBeUndefined();
          if (line.kind === "del") expect(line.newLine).toBeUndefined();
          if (line.kind === "ctx") expect(line.oldLine && line.newLine).toBeTruthy();
        }
      }
    }
  });
});

describe("toDiffView", () => {
  it("marks renames, binaries and patches too large to send", () => {
    const diff = toDiffView("h", [
      fromRestFile({ filename: "b.ts", previous_filename: "a.ts", status: "renamed", additions: 0, deletions: 0 }),
      fromRestFile({ filename: "logo.png", status: "modified", additions: 0, deletions: 0 }),
      fromRestFile({ filename: "huge.json", status: "modified", additions: 9000, deletions: 12 }),
    ]);
    expect(diff.files[0]).toMatchObject({ path: "b.ts", previousPath: "a.ts", status: "renamed", hunks: [] });
    expect(diff.files[0]?.binary).toBeUndefined();
    expect(diff.files[1]).toMatchObject({ binary: true, hunks: [] });
    expect(diff.files[2]).toMatchObject({ patchMissing: true, additions: 9000, deletions: 12, hunks: [] });
  });

  it("names context lines ctx", () => {
    const diff = toDiffView("h", [
      fromRestFile({
        filename: "a.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1,2 +1,2 @@\n keep\n-old\n+new",
      }),
    ]);
    expect(diff.files[0]?.hunks[0]?.lines).toEqual([
      { kind: "ctx", oldLine: 1, newLine: 1, text: "keep" },
      { kind: "del", oldLine: 2, text: "old" },
      { kind: "add", newLine: 2, text: "new" },
    ]);
  });
});

describe("pullRequestDiffView", () => {
  it("fetches once per head and serves the same head from the cache", async () => {
    const files = recorded("django-22038.json");
    const cache = new DiffCache();
    const first = fakeClient(files, ["sha1"]);
    const diff = await pullRequestDiffView(first.client, "django/django", 22038, cache);
    expect(diff.headSha).toBe("sha1");
    expect(diff.files.map((f) => f.path)).toEqual(files.map((f) => f.filename));
    expect(first.calls.filter((c) => c.endsWith("/files"))).toHaveLength(1);

    const again = fakeClient(files, ["sha1"]);
    expect(await pullRequestDiffView(again.client, "django/django", 22038, cache)).toBe(diff);
    expect(again.calls).toEqual(["GET /repos/{owner}/{repo}/pulls/{pull_number}"]);
  });

  it("fetches again after a push", async () => {
    const files = recorded("django-22038.json");
    const cache = new DiffCache();
    await pullRequestDiffView(fakeClient(files, ["sha1"]).client, "django/django", 22038, cache);
    const pushed = fakeClient(files, ["sha2"]);
    const diff = await pullRequestDiffView(pushed.client, "django/django", 22038, cache);
    expect(diff.headSha).toBe("sha2");
    expect(pushed.calls.filter((c) => c.endsWith("/files"))).toHaveLength(1);
  });

  it("pages through large PRs", async () => {
    const files = Array.from({ length: 150 }, (_, i) => ({
      filename: `f${i}.ts`,
      status: "added",
      additions: 1,
      deletions: 0,
      patch: "@@ -0,0 +1 @@\n+x",
    }));
    const diff = await pullRequestDiffView(fakeClient(files, ["s"]).client, "o/r", 1, new DiffCache());
    expect(diff.files).toHaveLength(150);
  });
});

describe("DiffCache", () => {
  it("keeps the most recently used few", () => {
    const cache = new DiffCache(2);
    cache.set("o/r", 1, { headSha: "a", files: [] });
    cache.set("o/r", 2, { headSha: "b", files: [] });
    cache.get("o/r", 1, "a");
    cache.set("o/r", 3, { headSha: "c", files: [] });
    expect(cache.get("o/r", 2, "b")).toBeUndefined();
    expect(cache.get("O/R", 1, "a")).toBeDefined();
    expect(cache.size).toBe(2);
  });
});

describe("localDiffView", () => {
  it("diffs the working tree against HEAD, with HEAD's commit", async () => {
    const repo = await realpath(await mkdtemp(join(tmpdir(), "alden-diffview-")));
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
      })
        .toString()
        .trim();
    try {
      git("init", "-q", "-b", "main");
      git("config", "core.autocrlf", "false");
      await writeFile(join(repo, "a.ts"), "one\ntwo\n");
      git("add", ".");
      git("commit", "-q", "-m", "initial");
      await writeFile(join(repo, "a.ts"), "one\nthree\n");
      await writeFile(join(repo, "new.ts"), "fresh\n");
      const diff = await localDiffView(repo);
      expect(diff.headSha).toBe(git("rev-parse", "HEAD"));
      expect(diff.files.map((f) => f.path).sort()).toEqual(["a.ts", "new.ts"]);
      const a = diff.files.find((f) => f.path === "a.ts");
      expect(a?.hunks[0]?.lines.map((l) => `${l.kind}:${l.text}`)).toEqual(["ctx:one", "del:two", "add:three"]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
