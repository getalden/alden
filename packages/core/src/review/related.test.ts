import type { LookHere } from "@alden/schema";
import { describe, expect, it } from "vitest";
import type { ChangedSymbol } from "../graph/changes.js";
import type { CallSite } from "../graph/query.js";
import { relatedFiles, withRelated } from "./related.js";
import type { GraphContext } from "./types.js";

const symbol = (path: string, name: string, startLine: number, endLine: number): ChangedSymbol => ({
  path,
  name,
  kind: "function",
  exported: true,
  change: "modified",
  startLine,
  endLine,
  changedLines: 1,
});
const site = (path: string, line: number, confidence: CallSite["confidence"] = "import"): CallSite => ({
  path,
  line,
  confidence,
});

const graph: GraphContext = {
  changes: [symbol("src/price.ts", "total", 1, 10), symbol("src/price.ts", "tax", 12, 20)],
  callers: new Map([
    [
      "src/price.ts#total",
      [
        site("src/cart.ts", 4),
        site("src/zz.ts", 9, "name"),
        site("src/checkout.ts", 7),
        site("src/a.ts", 1),
        site("src/b.ts", 2),
        site("src/c.ts", 3),
        site("src/price.test.ts", 12),
      ],
    ],
    ["src/price.ts#tax", [site("src/invoice.ts", 3)]],
  ]),
  complete: true,
  importers: new Map([
    [
      "src/price.ts",
      [site("src/cart.ts", 1), site("src/index.ts", 2), site("src/price.test.ts", 1), site("test/e2e/buy.ts", 1)],
    ],
  ]),
  modules: [{ path: "src/old.ts", importers: [site("src/x.ts", 1), site("src/y.ts", 2)] }],
};

const place = (path: string, line?: number, extra: Partial<LookHere> = {}): LookHere => ({
  title: "t",
  reason: "r",
  anchor: { path, ...(line ? { line } : {}) },
  ...extra,
});

describe("relatedFiles", () => {
  it("takes the callers of the symbol around the line, then tests, then importers, capped and one per file", () => {
    expect(relatedFiles(place("src/price.ts", 5), graph)).toEqual([
      { path: "src/a.ts", line: 1, why: "caller" },
      { path: "src/b.ts", line: 2, why: "caller" },
      { path: "src/c.ts", line: 3, why: "caller" },
      { path: "src/cart.ts", line: 4, why: "caller" },
      // The test's call, not its import line; then a test that only imports the file.
      { path: "src/price.test.ts", line: 12, why: "test" },
      { path: "test/e2e/buy.ts", line: 1, why: "test" },
      { path: "src/index.ts", line: 2, why: "importer" },
    ]);
  });

  it("puts name-only matches after sure ones", () => {
    const only = {
      ...graph,
      callers: new Map([["src/price.ts#total", [site("src/a.ts", 1, "name"), site("src/z.ts", 1)]]]),
    };
    expect(
      relatedFiles(place("src/price.ts", 5), only)
        .map((r) => r.path)
        .slice(0, 2),
    ).toEqual(["src/z.ts", "src/a.ts"]);
  });

  it("uses only the symbol at the line, or every changed symbol in the file without one", () => {
    expect(relatedFiles(place("src/price.ts", 15), graph).filter((r) => r.why === "caller")).toEqual([
      { path: "src/invoice.ts", line: 3, why: "caller" },
    ]);
    const small: GraphContext = {
      ...graph,
      callers: new Map([
        ["src/price.ts#total", [site("src/cart.ts", 4)]],
        ["src/price.ts#tax", [site("src/invoice.ts", 3)]],
      ]),
    };
    expect(relatedFiles(place("src/price.ts"), small).filter((r) => r.why === "caller")).toEqual([
      { path: "src/cart.ts", line: 4, why: "caller" },
      { path: "src/invoice.ts", line: 3, why: "caller" },
    ]);
  });

  it("gives a caller outside the diff the symbol's other callers, its tests and importers", () => {
    const related = relatedFiles(place("src/cart.ts", 4), graph);
    expect(related.some((r) => r.path === "src/cart.ts")).toBe(false);
    expect(related.filter((r) => r.why === "caller").map((r) => r.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/checkout.ts",
    ]);
    expect(related.find((r) => r.why === "test")).toEqual({ path: "src/price.test.ts", line: 12, why: "test" });
  });

  it("gives a file still importing a moved module the module's other importers", () => {
    expect(relatedFiles(place("src/x.ts", 1), graph)).toEqual([{ path: "src/y.ts", line: 2, why: "importer" }]);
  });

  it("has nothing for model findings, places without a file, or files the graph doesn't know", () => {
    expect(relatedFiles(place("src/price.ts", 5, { source: "llm" }), graph)).toEqual([]);
    expect(relatedFiles({ title: "t", reason: "r" }, graph)).toEqual([]);
    expect(relatedFiles(place("README.md", 1), graph)).toEqual([]);
  });

  it("leaves places alone without a graph, and adds related only where there is some", () => {
    const eyes = [place("src/price.ts", 15), place("README.md")];
    expect(withRelated(eyes, undefined)).toBe(eyes);
    const added = withRelated(eyes, graph);
    expect(added[0]?.related?.map((r) => r.why)).toEqual(["caller", "test", "test", "importer", "importer"]);
    expect(added[1]).toEqual(eyes[1]);
  });
});
