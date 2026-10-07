import type { Briefing } from "@alden/schema";
import { describe, expect, it } from "vitest";
import { blobUrl, excerptAround, guidedSteps, type PrDiffFile } from "./guided";

const file: PrDiffFile = {
  path: "src/charge.ts",
  status: "modified",
  hunks: [
    {
      header: "@@ -1,3 +1,4 @@",
      lines: [
        { kind: "ctx", oldLine: 1, newLine: 1, text: "a" },
        { kind: "del", oldLine: 2, text: "b" },
        { kind: "add", newLine: 2, text: "B" },
        { kind: "add", newLine: 3, text: "C" },
        { kind: "ctx", oldLine: 3, newLine: 4, text: "d" },
      ],
    },
    {
      header: "@@ -40,20 +41,20 @@",
      lines: Array.from({ length: 20 }, (_, i) => ({
        kind: "ctx" as const,
        oldLine: 40 + i,
        newLine: 41 + i,
        text: `line ${41 + i}`,
      })),
    },
  ],
};

describe("excerptAround", () => {
  it("takes six lines either side from the hunk holding the line", () => {
    const excerpt = excerptAround(file, 50);
    expect(excerpt?.focus).toBe(50);
    expect(excerpt?.lines.map((l) => l.newLine)).toEqual([44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56]);
  });

  it("stops at the hunk's edges, and keeps deleted lines", () => {
    expect(excerptAround(file, 2)?.lines.map((l) => l.text)).toEqual(["a", "b", "B", "C", "d"]);
  });

  it("starts at the first hunk without a line, and has nothing outside the diff", () => {
    expect(excerptAround(file)?.lines[0]?.text).toBe("a");
    expect(excerptAround(file, 30)).toBeUndefined();
    expect(excerptAround(undefined, 2)).toBeUndefined();
  });
});

describe("blobUrl", () => {
  it("links the file at the head commit and line", () => {
    expect(blobUrl("acme/api", "abc123", "src/a b.ts", 9)).toBe(
      "https://github.com/acme/api/blob/abc123/src/a%20b.ts#L9",
    );
    expect(blobUrl("acme/api", "abc123", "README.md")).toBe("https://github.com/acme/api/blob/abc123/README.md");
  });
});

describe("guidedSteps", () => {
  const briefing = {
    checks: [
      {
        id: "callers.outside",
        title: "Callers",
        status: "flagged",
        severity: "high",
        summary: "",
        evidence: [],
        heuristic: true,
      },
    ],
    needsYourEyes: [
      {
        title: "Caller of changed code in src/api.ts",
        reason: "calls charge.",
        anchor: { path: "src/api.ts", line: 9 },
        checkId: "callers.outside",
        related: [{ path: "src/web.ts", line: 3, why: "caller" }],
      },
      { title: "Model place", reason: "loops", anchor: { path: "src/loop.ts", line: 2 }, source: "llm" },
    ],
    llm: {
      status: "ok",
      findings: [
        { title: "Model place", detail: "loops", severity: "high", anchors: [{ path: "src/loop.ts", line: 2 }] },
        { title: "Nit", detail: "small", severity: "low", anchors: [{ path: "src/a.ts", line: 1 }] },
        { title: "Big", detail: "bad", severity: "high", anchors: [{ path: "src/b.ts", line: 4 }] },
        { title: "Nowhere", detail: "no place", severity: "high", anchors: [] },
      ],
      droppedFindings: 0,
      omittedFiles: [],
    },
  } as unknown as Briefing;

  it("puts Alden's places first, in order, then the model's other findings with a place, most severe first", () => {
    const { steps, core } = guidedSteps(briefing);
    expect(core).toBe(2);
    expect(steps.map((s) => `${s.kind}:${s.title}`)).toEqual([
      "place:Caller of changed code in src/api.ts",
      "place:Model place",
      "finding:Big",
      "finding:Nit",
    ]);
    expect(steps[0]).toMatchObject({ severity: "high", source: "check", related: [{ path: "src/web.ts" }] });
    expect(steps[1]?.source).toBe("llm");
  });

  it("has no extra steps without the model", () => {
    const { steps } = guidedSteps({ ...briefing, llm: undefined } as unknown as Briefing);
    expect(steps).toHaveLength(2);
  });
});
