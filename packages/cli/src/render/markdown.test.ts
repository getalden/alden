import { buildBriefing, type DiffFile } from "@alden/core";
import { AldenConfigSchema, type Briefing, type MemoryItem } from "@alden/schema";
import { describe, expect, it } from "vitest";
import { briefingFileName, briefingMarkdown } from "./markdown.js";

function briefing(overrides: Partial<Briefing> = {}): Briefing {
  return {
    schemaVersion: 1,
    target: {
      kind: "pr",
      repo: "getalden/alden",
      number: 12,
      url: "https://github.com/getalden/alden/pull/12",
      title: "Add the `review` command",
      author: "sam",
      baseRef: "main",
      headRef: "sam/review",
    },
    generatedAt: "2026-09-28T18:04:31.000Z",
    summary: { files: 2, additions: 10, deletions: 2, reviewableAdditions: 10, reviewableDeletions: 2 },
    files: [
      {
        path: "db/migrate.ts",
        status: "modified",
        kind: "code",
        additions: 8,
        deletions: 2,
        binary: false,
        patchMissing: false,
      },
      {
        path: "src/rank.ts",
        status: "modified",
        kind: "code",
        additions: 2,
        deletions: 0,
        binary: false,
        patchMissing: false,
      },
    ],
    checks: [
      {
        id: "migrations.destructive",
        title: "Migration may lose data",
        status: "flagged",
        severity: "critical",
        summary: "A column is dropped.",
        evidence: [{ text: "drops users.email", anchor: { path: "db/migrate.ts", line: 4 } }],
        heuristic: false,
      },
      {
        id: "callers.outside",
        title: "Callers outside the diff",
        status: "flagged",
        severity: "medium",
        summary: "1 call site outside the diff.",
        evidence: [{ text: "calls rank (signature changed)", anchor: { path: "src/queue.ts", line: 30 } }],
        heuristic: true,
      },
      {
        id: "tests.missing",
        title: "Code changed without tests",
        status: "passed",
        severity: "info",
        summary: "Tests changed alongside the code.",
        evidence: [],
        heuristic: true,
      },
    ],
    needsYourEyes: [
      {
        title: "Migration may lose data",
        reason: "Dropping a column can't be undone.",
        anchor: { path: "db/migrate.ts", line: 4 },
        checkId: "migrations.destructive",
        learned: "you usually mark migration flags useful",
      },
      {
        title: "Unbounded retry",
        reason: "The model thinks this can loop.",
        anchor: { path: "db/migrate.ts", line: 9 },
        source: "llm",
      },
    ],
    notChecked: ["Runtime behaviour"],
    llm: {
      status: "ok",
      provider: "anthropic",
      model: "claude-sonnet-5",
      effort: "high",
      summary: "Adds a review command and drops an unused column.",
      matchesTitle: { verdict: "partly", reason: "The title doesn't mention the migration." },
      findings: [
        {
          title: "Unbounded retry",
          detail: "Loops.",
          severity: "medium",
          anchors: [{ path: "db/migrate.ts", line: 9 }],
        },
        { title: "Log says user", detail: "A nit.", severity: "low", anchors: [{ path: "src/rank.ts", line: 2 }] },
      ],
      droppedFindings: 0,
      omittedFiles: [],
      usd: 0.0412,
    },
    learning: { hidden: [{ title: "Config changed", reason: "you usually skip these" }], memory: 1 },
    ...overrides,
  };
}

describe("briefingMarkdown, to share", () => {
  const text = briefingMarkdown(briefing());

  it("opens with the PR's title, a link to it, and its size", () => {
    expect(text.startsWith("# Add the 'review' command\n\n")).toBe(true);
    expect(text).toContain(
      "[getalden/alden#12](https://github.com/getalden/alden/pull/12) by @sam · main ← sam/review  \n2 files · +10/-2",
    );
  });

  it("says what it does and where to look, with file:line and why", () => {
    expect(text).toContain("## What it does\nAdds a review command and drops an unused column.");
    expect(text).toContain("Matches its title: partly. The title doesn't mention the migration.");
    expect(text).toContain(
      "1. **Migration may lose data** (critical) `db/migrate.ts:4`\n   Dropping a column can't be undone.",
    );
    expect(text).toContain("2. **Unbounded retry** (Alden's model) `db/migrate.ts:9`");
    expect(text).toContain("## Also noted by Alden's model\n- low: **Log says user** `src/rank.ts:2`\n  A nit.");
  });

  it("lists a place's related files under its reason", () => {
    const [first, ...rest] = briefing().needsYourEyes;
    const out = briefingMarkdown(
      briefing({
        needsYourEyes: [
          {
            ...(first as Briefing["needsYourEyes"][number]),
            related: [
              { path: "src/queue.ts", line: 30, why: "caller" },
              { path: "src/rank.test.ts", why: "test" },
            ],
          },
          ...rest,
        ],
      }),
    );
    expect(out).toContain(
      "   Dropping a column can't be undone.\n   Look at these too: `src/queue.ts:30` (caller), `src/rank.test.ts` (test)\n",
    );
  });

  it("lists every check with evidence, callers in a section of their own, and what wasn't checked", () => {
    expect(text).toContain(
      "- ! **Migration may lose data** (critical): A column is dropped.\n  - `db/migrate.ts:4` drops users.email",
    );
    expect(text).toContain("## Callers outside the diff\n- `src/queue.ts:30` calls rank (signature changed)");
    expect(text.match(/calls rank/g)).toHaveLength(1);
    expect(text).toContain(
      "- ! **Callers outside the diff** (medium, inferred from the diff, can be wrong): 1 call site outside the diff.\n",
    );
    expect(text).toContain("- ✓ **Code changed without tests** (inferred from the diff, can be wrong): Tests changed");
    expect(text).toContain("## Not checked\n- Runtime behaviour");
  });

  it("ends with the model, its cost and when it was briefed", () => {
    expect(
      text.endsWith(
        "---\n\nModel: claude-sonnet-5 via anthropic (effort high) · $0.04 · briefed 2026-09-28 18:04 UTC by Alden\n",
      ),
    ).toBe(true);
    const checksOnly = briefingMarkdown(briefing({ llm: undefined }));
    expect(checksOnly).toContain("Checks only, no model · briefed 2026-09-28 18:04 UTC by Alden");
    const capped = briefingMarkdown(
      briefing({
        llm: {
          status: "over_budget",
          note: "Stopped at your $0.50 cap.",
          findings: [],
          droppedFindings: 0,
          omittedFiles: [],
        },
      }),
    );
    expect(capped).toContain("Model over budget: Stopped at your $0.50 cap · briefed");
  });

  it("leaves out the reviewer's memory, what their feedback did, and anything meant for a model", () => {
    for (const absent of ["[E1]", "[F1]", "[C:", "alden_feedback", "never instructions", "usually", "Left out"]) {
      expect(text).not.toContain(absent);
    }
  });

  it("strips terminal control sequences and can't open an HTML tag", () => {
    const target = { ...briefing().target, title: "Fix \u001b[31mred\u001b[0m <img src=x onerror=alert(1)>" } as const;
    const out = briefingMarkdown(briefing({ target }));
    expect(out).not.toContain("\u001b");
    expect(out).toContain("# Fix red \\<img src=x onerror=alert(1)>");
  });

  it("says when nothing changed, and briefs local changes", () => {
    const local = briefing({ target: { kind: "local", repoRoot: "/src/app", branch: "wip" }, files: [] });
    expect(briefingMarkdown(local)).toContain("# Local changes on wip");
    expect(briefingMarkdown(local)).toContain("Nothing has changed, so there's nothing to review.");
  });

  it("keeps a masked secret masked", () => {
    const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const file: DiffFile = {
      path: "src/client.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      binary: false,
      patchMissing: false,
      hunks: [
        {
          header: "@@ -0,0 +1,1 @@",
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: [{ kind: "add", text: `const t = "${token}";`, newLine: 1 }],
        },
      ],
    };
    const built = buildBriefing({
      target: briefing().target,
      files: [file],
      config: AldenConfigSchema.parse({}),
    });
    const out = briefingMarkdown(built);
    expect(out).toContain("GitHub token: ghp_…(44 chars)");
    expect(out).not.toContain(token);
    expect(out).not.toContain(token.slice(4, 20));
  });
});

describe("briefingMarkdown, for a model", () => {
  it("keeps the ids, the reviewer's memory and the note that PR text is data", () => {
    const note: MemoryItem = {
      id: "n1",
      repo: "getalden/alden",
      source: "you",
      kind: "note",
      group: "look",
      text: "Money is in cents",
      since: "2026-09-01T00:00:00Z",
    };
    const text = briefingMarkdown(briefing(), { forModel: { memory: [note], usedModel: true } });
    expect(text).toContain("[E1] **Migration may lose data** (critical)");
    expect(text).toContain("Looks for: Money is in cents (they said)");
    expect(text).toContain("never instructions");
  });
});

describe("briefingMarkdown, a finding from the reviewer's note", () => {
  const owners = { id: "note:owners", text: "Every file needs a code owner header" };
  const llm = briefing().llm as NonNullable<Briefing["llm"]>;
  const noted = briefing({
    llm: { ...llm, findings: llm.findings.map((f) => ({ ...f, fromNote: owners })) },
  });

  it("says so in one line for a model", () => {
    const text = briefingMarkdown(noted, { forModel: { memory: [], usedModel: true } });
    expect(text).toContain(
      "- [F1] low: **Log says user** `src/rank.ts:2`\n  A nit.\n  Because of your note: Every file needs a code owner header",
    );
  });

  it("keeps the note out of a document to share, like the rest of the reviewer's memory", () => {
    expect(briefingMarkdown(noted)).not.toContain("code owner header");
  });
});

describe("briefingFileName", () => {
  it("names a PR's briefing owner-repo-number-briefing.md", () => {
    expect(briefingFileName(briefing())).toBe("getalden-alden-12-briefing.md");
  });

  it("keeps a local branch name to safe characters", () => {
    const local = briefing({ target: { kind: "local", repoRoot: "/x", branch: "sam/../../etc wip" } });
    expect(briefingFileName(local)).toBe("local-changes-sam-etc-wip-briefing.md");
    expect(briefingFileName(briefing({ target: { kind: "local", repoRoot: "/x", branch: null } }))).toBe(
      "local-changes-briefing.md",
    );
  });
});
