import { summarizeFeedback } from "@alden/core";
import { describe, expect, it } from "vitest";
import { renderFeedback } from "./feedback.js";

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

  it("says how to give feedback when there's none", () => {
    expect(renderFeedback(summarizeFeedback([]), false)).toContain("No feedback yet");
  });
});
