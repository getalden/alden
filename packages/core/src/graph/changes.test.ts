import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DiffFile, parseUnifiedDiff } from "../diff/parse.js";
import { changedNewLines, changedSymbols } from "./changes.js";
import { extractSymbols, type FileSymbols } from "./extract.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alden-changes-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Diffs two versions of `path` with git itself and parses both, as a review would see them. */
async function change(path: string, before: string, after: string) {
  await writeFile(join(dir, "a"), before);
  await writeFile(join(dir, "b"), after);
  const { stdout } = spawnSync("git", ["diff", "--no-index", "--no-color", "-U3", "a", "b"], {
    cwd: dir,
    encoding: "utf8",
  });
  const [parsed] = parseUnifiedDiff(stdout);
  const file: DiffFile = { ...(parsed as DiffFile), path };
  const afterSymbols = (await extractSymbols(path, after)) as FileSymbols;
  const beforeSymbols = (await extractSymbols(path, before)) as FileSymbols;
  return changedSymbols([file], new Map([[path, afterSymbols]]), new Map([[path, beforeSymbols]]));
}

const summary = (changes: Awaited<ReturnType<typeof change>>) =>
  changes.map((c) => `${c.change}:${c.container ? `${c.container}.` : ""}${c.name}`).sort();

const TS = `export class Ranker {
  weight = 1;

  rank(pr: Pr) {
    const base = pr.size;
    return base * this.weight;
  }

  reset() {
    this.weight = 1;
  }
}

export function formatAge(hours: number) {
  if (hours < 1) return "<1h";
  return \`\${hours}h\`;
}

function helper() {
  return 1;
}
`;

describe("changedSymbols", () => {
  it("reports the method whose body changed, not its class", async () => {
    expect(
      summary(await change("src/rank.ts", TS, TS.replace("base * this.weight", "base * this.weight * 2"))),
    ).toEqual(["modified:Ranker.rank"]);
  });

  it("reports the class when the change sits between its methods", async () => {
    expect(summary(await change("src/rank.ts", TS, TS.replace("weight = 1;", "weight = 2;")))).toEqual([
      "modified:Ranker",
    ]);
  });

  it("counts a deletion from the middle of a function as changing it", async () => {
    expect(summary(await change("src/rank.ts", TS, TS.replace('  if (hours < 1) return "<1h";\n', "")))).toEqual([
      "modified:formatAge",
    ]);
  });

  it("reports new and removed definitions", async () => {
    const after = TS.replace(
      "function helper() {\n  return 1;\n}\n",
      "export function slugify(s: string) {\n  return s.toLowerCase();\n}\n",
    );
    expect(summary(await change("src/rank.ts", TS, after))).toEqual(["added:slugify", "removed:helper"]);
  });

  it("carries whether the symbol is public", async () => {
    const [changed] = await change("src/rank.ts", TS, TS.replace("return 1;", "return 2;"));
    expect(changed).toMatchObject({ name: "helper", exported: false, changedLines: 1 });
  });

  it("works for Python, including decorators and methods", async () => {
    const py = `class Invoice:
    def total(self):
        return round(self.amount)

    @property
    def paid(self):
        return self.balance == 0


def charge(invoice):
    return invoice.total()
`;
    expect(summary(await change("billing/models.py", py, py.replace("@property", "@cached_property")))).toEqual([
      "modified:Invoice.paid",
    ]);
    expect(
      summary(await change("billing/models.py", py, py.replace("invoice.total()", "invoice.total() + 1"))),
    ).toEqual(["modified:charge"]);
  });

  it("reports everything in a deleted file as removed", async () => {
    const before = (await extractSymbols("src/old.ts", "export function gone() {}\n")) as FileSymbols;
    const file: DiffFile = {
      path: "src/old.ts",
      status: "removed",
      additions: 0,
      deletions: 1,
      binary: false,
      patchMissing: false,
      hunks: [],
    };
    expect(summary(changedSymbols([file], new Map(), new Map([["src/old.ts", before]])))).toEqual(["removed:gone"]);
  });
});

describe("changedNewLines", () => {
  it("places a pure deletion at the following new line", () => {
    const [file] = parseUnifiedDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,4 +1,3 @@\n a\n-b\n c\n d\n");
    expect([...changedNewLines(file as DiffFile)]).toEqual([2]);
  });
});
