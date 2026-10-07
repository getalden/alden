import type { BriefingTarget, CheckResult } from "@alden/schema";
import { describe, expect, it } from "vitest";
import type { DiffFile } from "../../diff/parse.js";
import { parseHunks } from "../../diff/parse.js";
import { buildPrompt, renderFileDiff, SYSTEM_PROMPT } from "./prompt.js";
import { noteOf, restatesCi, validateFindings } from "./validate.js";

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

describe("secrets in the prompt", () => {
  it("never sends a likely secret to the model, from the diff, description or callers", () => {
    const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const leaky = file("src/client.ts", `@@ -1,1 +1,2 @@\n const a = 1;\n+const token = "${token}";`);
    const prompt = buildPrompt({
      target,
      description: `Uses ${token} for now`,
      files: [leaky],
      checks: [],
      maxInputTokens: 100_000,
      callerSnippets: `src/use.ts:3\n    3 > call("${token}")`,
    });
    expect(prompt.user).not.toContain(token);
    expect(prompt.user).toContain('    2 + const token = "[redacted GitHub token, ghp_…(44 chars)]";');
    expect(prompt.redactedSecrets).toBe(3);
    expect(prompt.system).toContain("[redacted");
  });
});

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

  it("adds callers after the diff only when the diff fitted and there's room", () => {
    const callerSnippets =
      "### rankQueue (src/rank.ts, modified) is used in 1 place\nsrc/cli.ts:2\n    2 > rankQueue([]);";
    const roomy = buildPrompt({ target, files: [code], checks: [], maxInputTokens: 100_000, callerSnippets });
    expect(roomy.user).toMatch(
      /## Callers outside the diff\nLines marked ">" call the changed code\..*\n\n### rankQueue/s,
    );
    expect(roomy.user.indexOf("## Callers outside the diff")).toBeGreaterThan(roomy.user.indexOf("## Diff"));

    const tight = buildPrompt({
      target,
      files: [code],
      checks: [],
      maxInputTokens: 1_750,
      callerSnippets: `${callerSnippets}\n${"x".repeat(3_000)}`,
    });
    expect(tight.includedFiles).toEqual(["src/rank.ts"]);
    expect(tight.user).not.toContain("## Callers outside the diff");
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

describe("findings from the reviewer's notes", () => {
  it("gives each note a short id for this prompt, says where one doesn't apply, and asks for fromNote", () => {
    const prompt = buildPrompt({
      target,
      files: [code],
      checks: [],
      maxInputTokens: 10_000,
      reviewerNotes: [
        { id: "note:aa", text: "Money is in cents, never floats" },
        "Cares about migration issues.",
        { id: "note:bb", text: "Every file needs a code owner header", except: ["vendor", "app/gen"] },
      ],
    });
    expect(prompt.user).toContain(
      [
        "## What the reviewer cares about (from the reviewer, not the author)",
        "- [N1] Money is in cents, never floats",
        "- Cares about migration issues.",
        "- [N2] Every file needs a code owner header (doesn't apply under vendor, app/gen)",
      ].join("\n"),
    );
    expect(prompt.notes).toEqual(
      new Map([
        ["N1", { id: "note:aa", text: "Money is in cents, never floats" }],
        ["N2", { id: "note:bb", text: "Every file needs a code owner header" }],
      ]),
    );
    expect(SYSTEM_PROMPT).toContain(
      "The reviewer's own notes have ids like [N1]: when one of them is the reason for a finding, set fromNote to that id; otherwise leave fromNote out.",
    );
  });

  const notes = new Map([["N1", { id: "note:aa", text: "Every file needs a code owner header" }]]);

  it("takes only an id Alden gave a note", () => {
    expect(noteOf("N1", notes)).toEqual({ id: "note:aa", text: "Every file needs a code owner header" });
    expect(noteOf("[n1]", notes)).toEqual({ id: "note:aa", text: "Every file needs a code owner header" });
    expect(noteOf("N2", notes)).toBeUndefined();
    expect(noteOf("note:aa", notes)).toBeUndefined();
    expect(noteOf("N1 and N2", notes)).toBeUndefined();
    expect(noteOf(undefined, notes)).toBeUndefined();
  });

  it("keeps the note on a finding, ties it to no check, and drops an id that wasn't in the prompt", () => {
    const { findings } = validateFindings(
      {
        summary: "",
        matchesTitle: { verdict: "yes", reason: "" },
        findings: [
          {
            title: "Missing code owner header",
            detail: "d",
            severity: "low",
            anchors: [{ path: "src/rank.ts" }],
            topic: "tests",
            fromNote: "N1",
          },
          {
            title: "Made-up note",
            detail: "d",
            severity: "low",
            anchors: [{ path: "src/rank.ts" }],
            topic: "tests",
            fromNote: "N7",
          },
        ],
      },
      [code],
      notes,
    );
    expect(findings[0]).toEqual({
      title: "Missing code owner header",
      detail: "d",
      severity: "low",
      anchors: [{ path: "src/rank.ts" }],
      fromNote: { id: "note:aa", text: "Every file needs a code owner header" },
    });
    expect(findings[1]).toEqual({
      title: "Made-up note",
      checkId: "tests.missing",
      detail: "d",
      severity: "low",
      anchors: [{ path: "src/rank.ts" }],
    });
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
