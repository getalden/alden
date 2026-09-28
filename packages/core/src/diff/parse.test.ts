import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addedLines, parseHunks, parseUnifiedDiff } from "./parse.js";
import { fromRestFile } from "./sources.js";

const DIFF_DIR = join(import.meta.dirname, "../github/__fixtures__/diffs");
const restFiles = readdirSync(DIFF_DIR).flatMap((name) =>
  (
    JSON.parse(readFileSync(join(DIFF_DIR, name), "utf8")) as {
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    }[]
  ).map((file) => [`${name.replace(".json", "")}: ${file.filename}`, file] as const),
);

describe("parseHunks on real GitHub patches", () => {
  it.each(restFiles)("%s matches GitHub's line counts", (_label, file) => {
    const parsed = fromRestFile(file);
    expect(parsed.additions).toBe(file.additions);
    expect(parsed.deletions).toBe(file.deletions);
    if (file.patch) expect(parsed.hunks.length).toBeGreaterThan(0);
  });

  it("numbers lines in both files", () => {
    const [hunk] = parseHunks(
      "@@ -10,3 +10,4 @@ class Queue {\n context\n-old\n+new\n+added\n tail\n\\ No newline at end of file",
    );
    expect(hunk?.lines).toEqual([
      { kind: "context", text: "context", oldLine: 10, newLine: 10 },
      { kind: "del", text: "old", oldLine: 11 },
      { kind: "add", text: "new", newLine: 11 },
      { kind: "add", text: "added", newLine: 12 },
      { kind: "context", text: "tail", oldLine: 12, newLine: 13 },
    ]);
  });

  it("reads hunk headers without counts as one line", () => {
    const [hunk] = parseHunks("@@ -1 +1 @@\n-a\n+b");
    expect(hunk).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
  });
});

describe("fromRestFile", () => {
  it("tells a binary file from a diff too large for GitHub to show", () => {
    const binary = fromRestFile({ filename: "logo.png", status: "added", additions: 0, deletions: 0 });
    expect(binary).toMatchObject({ binary: true, patchMissing: false });
    const huge = fromRestFile({ filename: "data.sql", status: "modified", additions: 90000, deletions: 10 });
    expect(huge).toMatchObject({ binary: false, patchMissing: true, additions: 90000 });
  });

  it("keeps renames", () => {
    const file = fromRestFile({
      filename: "src/new.ts",
      previous_filename: "src/old.ts",
      status: "renamed",
      additions: 0,
      deletions: 0,
    });
    expect(file).toMatchObject({ path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" });
  });
});

const GIT_DIFF = `diff --git a/src/queue.ts b/src/queue.ts
index 1111111..2222222 100644
--- a/src/queue.ts
+++ b/src/queue.ts
@@ -1,2 +1,2 @@
 export const a = 1;
-export const b = 2;
+export const b = 3;
diff --git a/docs/new.md b/docs/new.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/docs/new.md
@@ -0,0 +1,2 @@
+# New
+diff --git lines inside content are fine
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/lib/a.go b/lib/b.go
similarity index 100%
rename from lib/a.go
rename to lib/b.go
diff --git a/src/util.py b/src/helpers.py
similarity index 80%
rename from src/util.py
rename to src/helpers.py
index 5555555..6666666 100644
--- a/src/util.py
+++ b/src/helpers.py
@@ -1 +1 @@
-def f(): pass
+def f(x): pass
diff --git a/assets/logo.png b/assets/logo.png
new file mode 100644
index 0000000..7777777
Binary files /dev/null and b/assets/logo.png differ
diff --git "a/docs/caf\\303\\251.md" "b/docs/caf\\303\\251.md"
index 8888888..9999999 100644
--- "a/docs/caf\\303\\251.md"
+++ "b/docs/caf\\303\\251.md"
@@ -1 +1 @@
-old
+new
`;

describe("parseUnifiedDiff", () => {
  const files = parseUnifiedDiff(GIT_DIFF);

  it("finds every file with its status", () => {
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["src/queue.ts", "modified"],
      ["docs/new.md", "added"],
      ["old.txt", "removed"],
      ["lib/b.go", "renamed"],
      ["src/helpers.py", "renamed"],
      ["assets/logo.png", "added"],
      ["docs/café.md", "modified"],
    ]);
  });

  it("counts lines and keeps rename sources", () => {
    expect(files[0]).toMatchObject({ additions: 1, deletions: 1 });
    expect(files[1]).toMatchObject({ additions: 2, deletions: 0 });
    expect(files[2]).toMatchObject({ additions: 0, deletions: 1 });
    expect(files[3]).toMatchObject({ previousPath: "lib/a.go", additions: 0, deletions: 0, hunks: [] });
    expect(files[4]).toMatchObject({ previousPath: "src/util.py", additions: 1, deletions: 1 });
  });

  it("marks binary files", () => {
    expect(files[5]).toMatchObject({ binary: true, hunks: [] });
  });

  it("lists added lines with their new line numbers", () => {
    expect(addedLines(files[1] as (typeof files)[number])).toEqual([
      { line: 1, text: "# New" },
      { line: 2, text: "diff --git lines inside content are fine" },
    ]);
  });
});
