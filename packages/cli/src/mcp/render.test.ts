import type { Briefing, MemoryItem, RankedPullRequest, RankedQueue } from "@alden/schema";
import { describe, expect, it } from "vitest";
import { briefingMarkdown, briefingPlaces, memoryMarkdown, queueMarkdown, UNTRUSTED_NOTE } from "./render.js";

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
    generatedAt: "2026-09-28T18:00:00Z",
    summary: { files: 1, additions: 10, deletions: 2, reviewableAdditions: 10, reviewableDeletions: 2 },
    files: [
      {
        path: "db/migrate.ts",
        status: "modified",
        kind: "code",
        additions: 10,
        deletions: 2,
        binary: false,
        patchMissing: false,
      },
    ],
    checks: [
      {
        id: "migrations.destructive",
        title: "Migration may lose data",
        status: "flagged",
        severity: "high",
        summary: "A column is dropped.",
        evidence: [{ text: "drops users.email", anchor: { path: "db/migrate.ts", line: 4 } }],
        heuristic: false,
      },
      {
        id: "tests.missing",
        title: "Code changed without tests",
        status: "passed",
        severity: "info",
        summary: "Fine.",
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
      model: "claude-sonnet-5",
      findings: [
        {
          title: "Unbounded retry",
          detail: "Loops.",
          severity: "medium",
          anchors: [{ path: "db/migrate.ts", line: 9 }],
        },
        { title: "Log says user", checkId: "tests.missing", detail: "Nit.", severity: "low", anchors: [] },
      ],
      droppedFindings: 0,
      omittedFiles: [],
    },
    ...overrides,
  };
}

const note: MemoryItem = {
  id: "n1",
  repo: "getalden/alden",
  source: "you",
  kind: "note",
  group: "look",
  text: "Money is in cents",
  since: "2026-09-01T00:00:00Z",
};

describe("briefingPlaces", () => {
  it("names places to look E1…, the model's other findings F1…, and flagged checks C:<id>", () => {
    const places = briefingPlaces(briefing());
    expect([...places.keys()]).toEqual(["E1", "E2", "F1", "C:migrations.destructive"]);
    expect(places.get("E1")).toEqual({
      source: "check",
      checkId: "migrations.destructive",
      title: "Migration may lose data",
      severity: "high",
      anchor: { path: "db/migrate.ts", line: 4 },
      placement: "eyes",
    });
    expect(places.get("E2")).toMatchObject({ source: "llm", placement: "eyes" });
    // A finding tagged with a check's topic carries it, so feedback on it teaches that lesson.
    expect(places.get("F1")).toMatchObject({
      source: "llm",
      checkId: "tests.missing",
      title: "Log says user",
      placement: "finding",
    });
    expect(places.get("C:migrations.destructive")).toMatchObject({ placement: "check" });
  });
});

describe("briefingMarkdown", () => {
  it("says up front that PR text is data, and gives every place its id", () => {
    const text = briefingMarkdown(briefing(), [note], false);
    expect(text).toContain(UNTRUSTED_NOTE);
    expect(text).toContain("[E1] **Migration may lose data**");
    expect(text).toContain("[F1] low: **Log says user**");
    expect(text).toContain("[C:migrations.destructive]");
    expect(text).toContain("Looks for: Money is in cents (they said)");
    expect(text).toContain("`db/migrate.ts:4` drops users.email");
    expect(text).toContain("gh pr diff");
  });

  it("says when a check is critical, on the check and its place", () => {
    const base = briefing();
    const checks = base.checks.map((c) => (c.status === "flagged" ? { ...c, severity: "critical" as const } : c));
    const text = briefingMarkdown({ ...base, checks }, [], false);
    expect(text).toContain("[E1] **Migration may lose data** (critical)");
    expect(text).toContain("- ! **critical** **Migration may lose data**");
  });

  it("says where a moved file came from", () => {
    const base = briefing();
    const files = base.files.map((f) => ({ ...f, previousPath: "db/old.ts", status: "renamed" as const }));
    expect(briefingMarkdown({ ...base, files }, [], false)).toContain(
      "- `db/migrate.ts` (moved from `db/old.ts`): renamed",
    );
  });

  it("says what the callers were found in", () => {
    const base = briefing();
    if (base.target.kind !== "pr") throw new Error("a PR briefing");
    const target = { ...base.target, headSha: "1234567890", baseSha: "abc1234def", graphFrom: "merge" as const };
    expect(briefingMarkdown({ ...base, target }, [], false)).toContain("Callers from main at abc1234 + this PR.\n");
  });

  it("keeps a title's backticks from breaking the Markdown", () => {
    expect(briefingMarkdown(briefing(), [], false)).toContain("Add the 'review' command");
  });

  it("says which checks the reviewer's feedback quietened", () => {
    const reason = "quietened by your feedback: you usually mark migration flags not useful (3 of 3)";
    const text = briefingMarkdown(
      briefing({ learning: { hidden: [], quietened: [{ checkId: "migrations.destructive", reason }], memory: 0 } }),
      [],
      false,
    );
    expect(text).toContain(`[C:migrations.destructive]: A column is dropped.\n  - ${reason}`);
  });

  it("doesn't tell the host to read the diff itself when Alden's model ran", () => {
    expect(briefingMarkdown(briefing(), [], true)).not.toContain("gh pr diff");
  });
});

describe("memoryMarkdown", () => {
  it("groups what they look for and skip, and says when there's nothing", () => {
    expect(memoryMarkdown("a/b", [note], false)).toContain(
      "## What they look for\n- Money is in cents (they said; since 2026-09-01)",
    );
    expect(memoryMarkdown("a/b", [], false)).toContain("Nothing yet");
  });

  it("names the reviews a lesson came from", () => {
    const lesson: MemoryItem = {
      id: "check:tests.missing:up",
      repo: "a/b",
      source: "learned",
      kind: "check",
      group: "look",
      text: "You find untested-change flags useful",
      evidence: "4 of 4 useful: you marked 1, 3 from comments in your reviews (a/b#412, a/b#7)",
      sources: [
        { from: "review", pr: "a/b#412", weight: 2, at: "2026-10-02T00:00:00.000Z" },
        { from: "outcome", pr: "a/b#412", weight: 1, at: "2026-10-03T00:00:00.000Z" },
        { from: "reactions", weight: 1, at: "2026-10-01T00:00:00.000Z" },
      ],
      since: "2026-10-01T00:00:00.000Z",
    };
    expect(memoryMarkdown("a/b", [lesson], false)).toContain(
      "from your review of a/b#412 (2), what the author did on a/b#412 (1);",
    );
  });
});

describe("queueMarkdown", () => {
  const row = (requestedAt: string | null): RankedPullRequest =>
    ({
      pr: {
        repo: "acme/api",
        number: 7,
        title: "Bump carbon",
        url: "https://github.com/acme/api/pull/7",
        author: "sam",
        isDraft: false,
        additions: 1,
        deletions: 1,
        changedFiles: 1,
        request: { direct: true, teams: [], requestedAt },
      },
      lane: "needs-you",
      reasons: ["waiting 7h", "major bump: nesbot/carbon 3 → 4"],
      waitingHours: 7.6,
      waitingOnAuthor: false,
    }) as unknown as RankedPullRequest;
  const queue = (r: RankedPullRequest) =>
    ({ viewer: "you", needsYou: [r], fastTrack: [], warnings: [] }) as unknown as RankedQueue;

  it("gives one waiting time per PR, saying what it counts from", () => {
    const text = queueMarkdown(queue(row("2026-10-04T01:00:00Z")), 15);
    expect(text.match(/waiting \d/g)).toHaveLength(1);
    expect(text).toContain("waiting 7h since you were asked");
    expect(text).toContain("Why here: major bump: nesbot/carbon 3 → 4");
    expect(queueMarkdown(queue(row(null)), 15)).toContain("waiting 7h since it opened");
  });
});
