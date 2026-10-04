import { learn, summarizeFeedback } from "@alden/core";
import { describe, expect, it } from "vitest";
import { learningLines, renderFeedback } from "./feedback.js";

describe("renderFeedback", () => {
  it("leads with the gate's number and breaks it down by check", () => {
    const summary = summarizeFeedback([
      ...["a", "b", "c"].map((title, i) => ({
        schemaVersion: 1 as const,
        id: String(i),
        at: `2026-09-30T10:0${i}:00.000Z`,
        target: { kind: "pr" as const, repo: "acme/api", number: 1 },
        briefingAt: "2026-09-30T09:00:00.000Z",
        kind: "verdict" as const,
        item: { source: "check" as const, checkId: "callers.outside", title, placement: "eyes" as const },
        verdict: i === 2 ? ("not_needed" as const) : ("agree" as const),
      })),
    ]);
    const text = renderFeedback(summary, false);
    expect(text).toContain('Useful rate on "needs your eyes": 67% (2 of 3)');
    expect(text).toMatch(/callers\.outside\s+2 useful\s+1 not useful\s+67%/);
  });

  it("says where each lesson stands, signatures and callers as one", () => {
    const verdict = (i: number, checkId: string, v: "agree" | "not_needed") => ({
      schemaVersion: 1 as const,
      id: `${checkId}${i}`,
      at: "2026-09-30T10:00:00.000Z",
      target: { kind: "pr" as const, repo: "acme/api", number: i },
      briefingAt: "2026-09-30T09:00:00.000Z",
      kind: "verdict" as const,
      item: { source: "check" as const, checkId, title: "t", placement: "eyes" as const },
      verdict: v,
    });
    const learning = learn({
      repo: "acme/api",
      feedback: [
        verdict(1, "callers.outside", "not_needed"),
        verdict(2, "signatures.changed", "not_needed"),
        ...[3, 4, 5].map((i) => verdict(i, "migrations.changed", "agree")),
      ],
      opens: [],
      memory: [],
    });
    const lines = learningLines(learning);
    expect(lines).toEqual([
      "2 of 3: one more not useful on API change flags (public signature and caller flags count together) and Alden will quieten them.",
      "3 of 3 useful on migration flags: Alden puts them first among the places to look in this repo.",
    ]);
    const text = renderFeedback(summarizeFeedback([]), false, [{ repo: "acme/api", lines }]);
    expect(text).toContain("No feedback yet");
    const some = summarizeFeedback([verdict(1, "callers.outside", "not_needed")]);
    expect(renderFeedback(some, false, [{ repo: "acme/api", lines }])).toContain(
      "What Alden is learning\n  acme/api\n    2 of 3",
    );
  });

  it("says how to give feedback when there's none", () => {
    expect(renderFeedback(summarizeFeedback([]), false)).toContain("No feedback yet");
  });
});
