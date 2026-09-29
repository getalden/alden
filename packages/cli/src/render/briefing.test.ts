import type { Briefing, CheckResult } from "@alden/schema";
import { describe, expect, it } from "vitest";
import { renderBriefing } from "./briefing.js";

const check = (overrides: Partial<CheckResult> = {}): CheckResult => ({
  id: "tests.missing",
  title: "Code changed without tests",
  status: "passed",
  severity: "info",
  summary: "1 test file changed alongside 1 code file.",
  evidence: [],
  heuristic: true,
  ...overrides,
});

function briefing(overrides: Partial<Briefing> = {}): Briefing {
  return {
    schemaVersion: 1,
    target: {
      kind: "pr",
      repo: "getalden/alden",
      number: 12,
      url: "https://github.com/getalden/alden/pull/12",
      title: "Add the review command",
      author: "sam",
      baseRef: "main",
      headRef: "sam/review",
    },
    generatedAt: "2026-09-28T18:00:00Z",
    summary: { files: 2, additions: 120, deletions: 10, reviewableAdditions: 120, reviewableDeletions: 10 },
    files: [
      {
        path: "src/a.ts",
        status: "modified",
        kind: "code",
        additions: 100,
        deletions: 10,
        binary: false,
        patchMissing: false,
      },
      {
        path: "src/a.test.ts",
        status: "added",
        kind: "test",
        additions: 20,
        deletions: 0,
        binary: false,
        patchMissing: false,
      },
    ],
    checks: [check()],
    needsYourEyes: [],
    notChecked: ["Callers and code outside the diff (the code graph is coming)"],
    ...overrides,
  };
}

const plain = (b: Briefing, width = 100) => renderBriefing(b, { width, color: false });

describe("renderBriefing", () => {
  it("opens with the PR, its branches and size", () => {
    const lines = plain(briefing()).split("\n");
    expect(lines[0]).toBe("getalden/alden#12  Add the review command");
    expect(lines[1]).toBe("@sam · main ← sam/review · 2 files · +120/-10");
    expect(lines[2]).toBe("https://github.com/getalden/alden/pull/12");
  });

  it("mentions lockfiles only when they change the size", () => {
    const b = briefing({
      summary: { files: 3, additions: 900, deletions: 10, reviewableAdditions: 120, reviewableDeletions: 10 },
    });
    expect(plain(b)).toContain("+900/-10 (+120/-10 without lockfiles)");
  });

  it("describes local changes", () => {
    const out = plain(briefing({ target: { kind: "local", repoRoot: "/code/alden", branch: "feature" } }));
    expect(out.split("\n").slice(0, 2)).toEqual([
      "Local changes on feature",
      "/code/alden · 2 files · +120/-10 · compared with HEAD",
    ]);
  });

  it("says so when nothing needs a closer look", () => {
    expect(plain(briefing())).toContain("Nothing flagged. The checks below found nothing that needs a closer look.");
  });

  it("numbers the places to look, with their lines and reasons", () => {
    const out = plain(
      briefing({
        needsYourEyes: [
          {
            title: "Possible secret in src/keys.ts",
            reason: "GitHub token: ghp_…(44 chars). Rotate it.",
            anchor: { path: "src/keys.ts", line: 12 },
            checkId: "secrets.likely",
          },
        ],
      }),
    );
    expect(out).toContain("  1. Possible secret in src/keys.ts:12\n     GitHub token: ghp_…(44 chars). Rotate it.");
  });

  it("shows evidence for flagged checks only, with the line where the text names the file", () => {
    const out = plain(
      briefing({
        checks: [
          check({
            status: "flagged",
            severity: "medium",
            summary: "1 code file changed and no tests were added or updated.",
            evidence: [{ text: "no matching test change: src/a.ts", anchor: { path: "src/a.ts", line: 10 } }],
          }),
          check({ id: "deps", title: "Dependencies", heuristic: false, evidence: [{ text: "hidden" }] }),
        ],
      }),
    );
    expect(out).toMatch(/! Code changed without tests ~\s+medium\s+1 code file changed/);
    expect(out).toContain("      no matching test change: src/a.ts:10");
    expect(out).not.toContain("hidden");
    expect(out).toContain("~ inferred from the diff alone");
  });

  it("aligns wrapped summaries under the first line", () => {
    const long = "word ".repeat(40).trim();
    const lines = plain(briefing({ checks: [check({ summary: long })] }), 80).split("\n");
    const first = lines.findIndex((l) => l.includes("✓ Code changed without tests"));
    const column = (lines[first] as string).indexOf("word");
    expect((lines[first + 1] as string).indexOf("word")).toBe(column);
    expect(lines.every((l) => l.length <= 80)).toBe(true);
  });

  it("lists what wasn't checked", () => {
    expect(plain(briefing())).toMatch(/Not checked\n {2}· Callers and code outside the diff/);
  });

  describe("with the model's view", () => {
    const withModel = briefing({
      needsYourEyes: [
        {
          title: "fetchCatalog callers must handle Catalog",
          reason: "The return type changed.",
          anchor: { path: "src/client.ts", line: 191 },
          source: "llm",
        },
      ],
      llm: {
        status: "ok",
        provider: "anthropic",
        model: "claude-sonnet-5",
        summary: "Searches the whole metric catalog on the server.",
        matchesTitle: { verdict: "partly", reason: "It also changes the return type." },
        findings: [
          {
            title: "fetchCatalog callers must handle Catalog",
            detail: "The return type changed.",
            severity: "high",
            anchors: [{ path: "src/client.ts", line: 191 }],
          },
          {
            title: "Naming nit",
            detail: "Minor.",
            severity: "low",
            anchors: [{ path: "src/a.ts", line: 3 }, { path: "src/b.ts" }],
          },
        ],
        droppedFindings: 1,
        omittedFiles: [],
        usd: 0.0412,
        effort: "medium",
      },
    });
    const out = plain(withModel);

    it("opens with what the change does and whether it matches its title", () => {
      expect(out).toContain(
        "What it does\n  Searches the whole metric catalog on the server.\n  Matches its title: partly · It also changes the return type.",
      );
    });

    it("marks the model's picks and lists its other findings", () => {
      expect(out).toContain(
        "  1. fetchCatalog callers must handle Catalog (model)\n     src/client.ts:191\n     The return type changed.",
      );
      expect(out).toMatch(/Also noted by the model\n {2}low {4}Naming nit {2}src\/a\.ts:3 \+1\n {9}Minor\./);
      expect(out.match(/fetchCatalog callers/g)).toHaveLength(1);
    });

    it("ends with the model, its cost and what was dropped", () => {
      expect(plain(withModel, 120).trimEnd().split("\n").at(-1)).toBe(
        "Model: claude-sonnet-5 via anthropic (effort medium) · $0.04 · 1 finding dropped for pointing at lines not in the diff",
      );
    });

    it("says how many secrets were hidden from the model", () => {
      const llm = withModel.llm && { ...withModel.llm, droppedFindings: 0, redactedSecrets: 2 };
      expect(
        plain({ ...withModel, ...(llm ? { llm } : {}) }, 120)
          .trimEnd()
          .split("\n")
          .at(-1),
      ).toBe("Model: claude-sonnet-5 via anthropic (effort medium) · $0.04 · 2 likely secrets hidden from the model");
    });

    it("explains why the model didn't run", () => {
      const skipped = plain(
        briefing({
          llm: {
            status: "skipped",
            note: "No Anthropic API key found.",
            findings: [],
            droppedFindings: 0,
            omittedFiles: [],
          },
        }),
      );
      expect(skipped).not.toContain("What it does");
      expect(skipped.trimEnd().split("\n").at(-1)).toBe("Model not used: No Anthropic API key found.");
      const refused = plain(
        briefing({
          llm: { status: "over_budget", note: "Over the cap.", findings: [], droppedFindings: 0, omittedFiles: [] },
        }),
      );
      expect(refused).toContain("Model over budget: Over the cap.");
    });
  });

  it("stops early when nothing changed", () => {
    expect(plain(briefing({ files: [], checks: [] }))).toContain("Nothing has changed, so there's nothing to review.");
  });
});
