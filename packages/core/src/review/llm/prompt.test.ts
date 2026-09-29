import type { BriefingTarget, CheckResult } from "@alden/schema";
import { describe, expect, it } from "vitest";
import type { DiffFile } from "../../diff/parse.js";
import { parseHunks } from "../../diff/parse.js";
import { buildPrompt, renderFileDiff, SYSTEM_PROMPT } from "./prompt.js";
import { restatesCi, validateFindings } from "./validate.js";

const target: BriefingTarget = {
  kind: "pr",
  repo: "getalden/alden",
  number: 12,
  url: "https://github.com/getalden/alden/pull/12",
  title: "Rank failing CI last",
  author: "sam",
  baseRef: "main",
  headRef: "sam/ci",
};

function file(path: string, patch: string, overrides: Partial<DiffFile> = {}): DiffFile {
  const hunks = parseHunks(patch);
  const count = (kind: string) => hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === kind).length, 0);
  return {
    path,
    status: "modified",
    additions: count("add"),
    deletions: count("del"),
    binary: false,
    patchMissing: false,
    hunks,
    ...overrides,
  };
}

const code = file(
  "src/rank.ts",
  "@@ -10,3 +10,3 @@ export function rank() {\n const a = 1;\n-if (ci) risk++;\n+if (ci) sink = true;\n return a;",
);

describe("renderFileDiff", () => {
  it("prefixes lines with their new-file numbers and leaves deletions unnumbered", () => {
    expect(renderFileDiff(code).split("\n")).toEqual([
      "### src/rank.ts (modified, +1/-1)",
      "@@ -10,3 +10,3 @@ export function rank() {",
      "   10   const a = 1;",
      "      - if (ci) risk++;",
      "   11 + if (ci) sink = true;",
      "   12   return a;",
    ]);
  });

  it("marks binary files, oversized diffs and renames", () => {
    expect(renderFileDiff(file("logo.png", "", { binary: true }))).toContain("(binary file)");
    expect(renderFileDiff(file("dump.sql", "", { patchMissing: true }))).toContain("(diff too large to fetch)");
    expect(renderFileDiff(file("b.ts", "", { previousPath: "a.ts", status: "renamed" }))).toMatch(/^### a\.ts → b\.ts/);
  });
});

describe("buildPrompt", () => {
  const checks: CheckResult[] = [
    {
      id: "tests.missing",
      title: "Code changed without tests",
      status: "flagged",
      severity: "medium",
      summary: "1 code file changed and no tests were added or updated.",
      evidence: [{ text: "no matching test change: src/rank.ts", anchor: { path: "src/rank.ts", line: 11 } }],
      heuristic: true,
    },
  ];

  it("includes the title, description, check results and numbered diff", () => {
    const prompt = buildPrompt({
      target,
      description: "Moves failing CI down.",
      files: [code],
      checks,
      maxInputTokens: 100_000,
    });
    expect(prompt.system).toBe(SYSTEM_PROMPT);
    expect(prompt.user).toContain("# getalden/alden#12: Rank failing CI last");
    expect(prompt.user).toContain("## Description\nMoves failing CI down.");
    expect(prompt.user).toContain("- [flagged, medium] Code changed without tests: 1 code file changed");
    expect(prompt.user).toContain("    - no matching test change: src/rank.ts");
    expect(prompt.user).toContain("   11 + if (ci) sink = true;");
    expect(prompt).toMatchObject({ includedFiles: ["src/rank.ts"], omittedFiles: [] });
  });

  it("says when there's no description", () => {
    expect(buildPrompt({ target, files: [code], checks: [], maxInputTokens: 100_000 }).user).toContain(
      "(no description)",
    );
  });

  it("keeps lockfiles out without calling them omitted", () => {
    const lock = file("pnpm-lock.yaml", "@@ -1 +1 @@\n-a\n+b");
    const prompt = buildPrompt({ target, files: [code, lock], checks: [], maxInputTokens: 100_000 });
    expect(prompt.user).not.toContain("pnpm-lock.yaml");
    expect(prompt.omittedFiles).toEqual([]);
  });

  it("fills the budget in priority order and names what didn't fit", () => {
    const big = (path: string) =>
      file(
        path,
        `@@ -0,0 +1,300 @@\n${Array.from({ length: 300 }, (_, i) => `+line ${i} ${"x".repeat(40)}`).join("\n")}`,
      );
    const files = [big("docs/guide.md"), big("tests/test_rank.py"), big("src/other.ts"), code];
    // Room for the system prompt, preamble, the small flagged file and about one big file.
    const prompt = buildPrompt({ target, files, checks, maxInputTokens: 7_500 });
    expect(prompt.includedFiles).toEqual(["src/other.ts", "src/rank.ts"]);
    expect(prompt.omittedFiles).toEqual(["tests/test_rank.py", "docs/guide.md"]);
    expect(prompt.user).toContain("## Not shown (over budget)\n- tests/test_rank.py\n- docs/guide.md");
  });
});

describe("validateFindings", () => {
  const shown = [code];
  const finding = (anchors: { path: string; line?: number }[]) => ({
    title: "t",
    detail: "d",
    severity: "medium" as const,
    anchors,
  });

  it("keeps anchors on visible lines and whole-file anchors", () => {
    const { findings, dropped } = validateFindings(
      {
        summary: "",
        matchesTitle: { verdict: "yes", reason: "" },
        findings: [finding([{ path: "src/rank.ts", line: 11 }, { path: "src/rank.ts" }])],
      },
      shown,
    );
    expect(dropped).toBe(0);
    expect(findings[0]?.anchors).toEqual([{ path: "src/rank.ts", line: 11 }, { path: "src/rank.ts" }]);
  });

  it("drops findings pointing only at invented files or lines, and trims bad anchors from mixed ones", () => {
    const { findings, dropped } = validateFindings(
      {
        summary: "",
        matchesTitle: { verdict: "yes", reason: "" },
        findings: [
          finding([{ path: "src/imaginary.ts", line: 3 }]),
          finding([{ path: "src/rank.ts", line: 999 }]),
          finding([
            { path: "src/rank.ts", line: 999 },
            { path: "src/rank.ts", line: 10 },
          ]),
        ],
      },
      shown,
    );
    expect(dropped).toBe(2);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.anchors).toEqual([{ path: "src/rank.ts", line: 10 }]);
  });

  it("keeps general findings that name no place", () => {
    const { findings } = validateFindings(
      { summary: "", matchesTitle: { verdict: "no", reason: "" }, findings: [finding([])] },
      shown,
    );
    expect(findings).toHaveLength(1);
  });
});

describe("restatesCi", () => {
  it.each([
    "CI is failing on this branch",
    "CI is failing on this PR",
    "Checks failing",
    "Build is broken.",
    "Tests are failing",
  ])("drops %s", (title) => {
    expect(restatesCi(title)).toBe(true);
  });

  it.each([
    "CI is failing — possible missing `iter` import in bleve.go",
    "Retry loop can hide CI flakiness",
    "Tests don't cover NULL",
  ])("keeps %s", (title) => {
    expect(restatesCi(title)).toBe(false);
  });
});
