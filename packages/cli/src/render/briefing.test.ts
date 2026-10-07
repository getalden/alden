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
    notChecked: ["Callers and code outside the diff (the code graph didn't run)"],
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

  it("says why learning picked a place, what it hid (grouped), and how many notes the model saw", () => {
    const out = plain(
      briefing({
        needsYourEyes: [
          {
            title: "Migration in db/1.sql",
            reason: "Adds a column. Migrations changed.",
            anchor: { path: "db/1.sql" },
            checkId: "migrations.changed",
            learned: "You usually mark migration flags useful (4 of 4)",
          },
        ],
        learning: {
          hidden: ["a.ts", "b.ts", "c.ts"].map((path) => ({
            title: `Untested change in ${path}`,
            reason: "You usually mark untested-change flags not useful (3 of 3)",
            anchor: { path },
          })),
          memory: 1,
        },
      }),
    );
    expect(out).toContain("     ↑ You usually mark migration flags useful (4 of 4)");
    expect(out).toContain(
      "  Hidden: 3 places (a.ts, b.ts +1). You usually mark untested-change flags not useful (3 of 3).",
    );
    expect(out).toContain("  The model was given 1 note on what you care about here (`alden memory`).");
  });

  it("marks a check your feedback quietened in the checks list", () => {
    const reason = "quietened by your feedback: you usually mark untested-change flags not useful (3 of 3)";
    const out = plain(
      briefing({
        checks: [check({ status: "flagged", severity: "medium", summary: "1 code file changed without tests." })],
        learning: { hidden: [], quietened: [{ checkId: "tests.missing", reason }], memory: 0 },
      }),
    );
    expect(out).toContain(`      ↓ ${reason}`);
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

  it("lists a place's related files under its reason", () => {
    const out = plain(
      briefing({
        needsYourEyes: [
          {
            title: "Caller of changed code in src/cli.ts",
            reason: "calls rankQueue (signature changed).",
            anchor: { path: "src/cli.ts", line: 2 },
            checkId: "callers.outside",
            related: [
              { path: "src/api.ts", line: 2, why: "caller" },
              { path: "src/rank.test.ts", line: 9, why: "test" },
            ],
          },
        ],
      }),
    );
    expect(out).toContain(
      "     calls rankQueue (signature changed).\n     Look at these too: src/api.ts:2 (caller), src/rank.test.ts:9 (test)",
    );
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

  it("lists moved files with where they came from", () => {
    const moved = {
      path: "src/lib/pricing.ts",
      previousPath: "src/pricing.ts",
      status: "renamed" as const,
      kind: "code" as const,
      additions: 0,
      deletions: 0,
      binary: false,
      patchMissing: false,
    };
    const out = plain(briefing({ files: [...briefing().files, moved] }));
    expect(out).toContain("Moved\n  src/lib/pricing.ts moved from src/pricing.ts (no edits)\n");
    expect(plain(briefing())).not.toContain("Moved");
  });

  it("labels critical checks in full", () => {
    const flagged = check({
      id: "secrets.likely",
      title: "Likely secrets",
      status: "flagged",
      severity: "critical",
      summary: "1 likely secret in added lines.",
    });
    expect(plain(briefing({ checks: [flagged] }))).toMatch(/! Likely secrets ~\s+critical\s+1 likely secret/);
    // In colour it's bold as well as red, unlike high.
    expect(renderBriefing(briefing({ checks: [flagged] }), { width: 100, color: true })).toContain(
      "\u001b[1m\u001b[31mcritical\u001b[39m\u001b[22m",
    );
  });

  it("aligns wrapped summaries under the first line", () => {
    const long = "word ".repeat(40).trim();
    const lines = plain(briefing({ checks: [check({ summary: long })] }), 80).split("\n");
    const first = lines.findIndex((l) => l.includes("✓ Code changed without tests"));
    const column = (lines[first] as string).indexOf("word");
    expect((lines[first + 1] as string).indexOf("word")).toBe(column);
    expect(lines.every((l) => l.length <= 80)).toBe(true);
  });

  describe("evidence", () => {
    const signatures = check({
      id: "signatures.changed",
      title: "Changed public signatures",
      status: "flagged",
      severity: "medium",
      summary: "1 public signature changed or removed.",
      evidence: [
        {
          text: "changed: export function lineTotal(line: LineItem, currency: Currency): number → export function lineTotal(line: LineItem, currency: Currency, taxRate: number): number",
          anchor: { path: "packages/checkout/src/pricing/line-total.ts", line: 12 },
        },
      ],
    });
    const callers = check({
      id: "callers.outside",
      title: "Callers outside the diff",
      status: "flagged",
      severity: "high",
      summary: "1 removed or re-signed public symbol still called from 1 place this PR didn't change.",
      evidence: [
        {
          text: "calls lineTotal (signature changed), name match only",
          anchor: { path: "packages/storefront/src/components/cart/CartSummaryLineItemRow.tsx", line: 148 },
        },
      ],
    });

    it("puts a changed signature's old and new forms on lines of their own, wrapped, never cut", () => {
      const out = plain(briefing({ checks: [signatures] }), 80);
      const lines = out.split("\n");
      expect(lines.every((l) => l.length <= 80)).toBe(true);
      expect(out).not.toContain("…");
      expect(out).toContain("      packages/checkout/src/pricing/line-total.ts:12  changed:\n");
      expect(out).toContain(
        "        - export function lineTotal(line: LineItem, currency: Currency): number\n" +
          "        + export function lineTotal(line: LineItem, currency: Currency, taxRate:\n" +
          "          number): number\n",
      );
    });

    it("colours only the part of the signature that changed", () => {
      const out = renderBriefing(briefing({ checks: [signatures] }), { width: 120, color: true });
      expect(out).toContain("\u001b[32m, taxRate: number\u001b[39m");
      expect(out).not.toContain("\u001b[31m");
    });

    it("wraps long caller lines under themselves instead of cutting them", () => {
      const lines = plain(briefing({ checks: [callers] }), 80).split("\n");
      const first = lines.findIndex((l) => l.includes("CartSummaryLineItemRow"));
      expect(lines[first]).toBe("      packages/storefront/src/components/cart/CartSummaryLineItemRow.tsx:148");
      expect(lines[first + 1]).toBe("        calls lineTotal (signature changed), name match only");
    });
  });

  it("lists what wasn't checked", () => {
    expect(plain(briefing())).toMatch(/Not checked\n {2}· Callers and code outside the diff/);
  });

  it("ends with what the callers were found in: the base at a commit plus the PR, or the PR's branch", () => {
    const pr = briefing().target;
    if (pr.kind !== "pr") throw new Error("a PR briefing");
    const fromMerge = briefing({
      target: { ...pr, headSha: "1234567890ab", baseSha: "abc1234def", graphFrom: "merge" },
    });
    expect(plain(fromMerge).trimEnd().split("\n").slice(-2)).toEqual(["", "Callers from main at abc1234 + this PR"]);
    const fromHead = briefing({ target: { ...pr, headSha: "1234567890ab", graphFrom: "head" } });
    expect(plain(fromHead).trimEnd().split("\n").at(-1)).toBe(
      "Callers from the PR's branch at 1234567, not main as it is now",
    );
    expect(plain(briefing())).not.toMatch(/Callers from/);
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
      expect(out).toMatch(/Also noted by the model\n {2}low {6}Naming nit {2}src\/a\.ts:3 \+1\n {11}Minor\./);
      expect(out.match(/fetchCatalog callers/g)).toHaveLength(1);
    });

    it("says when a finding came from one of your notes", () => {
      const owners = { id: "note:owners", text: "Every file needs a code owner header" };
      const llm = withModel.llm as NonNullable<typeof withModel.llm>;
      const noted = plain(
        {
          ...withModel,
          needsYourEyes: withModel.needsYourEyes.map((e) => ({ ...e, fromNote: owners })),
          llm: { ...llm, findings: llm.findings.map((f) => ({ ...f, fromNote: owners })) },
        },
        120,
      );
      expect(noted).toContain(
        "     The return type changed.\n     Because of your note: Every file needs a code owner header",
      );
      expect(noted).toContain(
        "           Minor.\n           Because of your note: Every file needs a code owner header",
      );
      expect(out).not.toContain("Because of your note");
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

describe("untrusted text", () => {
  it("never passes terminal control sequences through from titles, paths or model text", () => {
    const evil = "\u001b]52;c;cGF3bmVk\u0007\u001b[2JFix it\rnow";
    const out = renderBriefing(
      briefing({
        target: { ...briefing().target, title: evil } as Briefing["target"],
        needsYourEyes: [{ title: evil, reason: `${evil} reason`, anchor: { path: `src/${evil}.ts`, line: 1 } }],
      }),
      { width: 100, color: false },
    );
    const control = [...out].filter((c) => {
      const code = c.charCodeAt(0);
      return (code < 32 && c !== "\n" && c !== "\t") || (code >= 0x7f && code <= 0x9f);
    });
    expect(control).toEqual([]);
    expect(out).toContain("Fix itnow");
    expect(out).not.toContain("[2J");
    expect(out).not.toContain("]52;");
  });
});
