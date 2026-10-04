import type { RankedQueue } from "@alden/schema";
import { describe, expect, it } from "vitest";
import { nextToPrepare } from "./api.js";

const row = (number: number, extra: { draft?: boolean; onAuthor?: boolean; updatedAt?: string } = {}) =>
  ({
    pr: { repo: "a/b", number, isDraft: extra.draft ?? false, updatedAt: extra.updatedAt ?? "2026-10-01T00:00:00Z" },
    waitingOnAuthor: extra.onAuthor ?? false,
  }) as unknown as RankedQueue["needsYou"][number];
const queue = (...rows: RankedQueue["needsYou"]) => ({ needsYou: rows, fastTrack: [] }) as unknown as RankedQueue;

describe("nextToPrepare", () => {
  it("takes the first of the top three that's ready for review and not yet briefed", () => {
    const q = queue(row(1, { draft: true }), row(2, { onAuthor: true }), row(3), row(4));
    expect(nextToPrepare(q, () => undefined)?.pr.number).toBe(3);
  });

  it("briefs a PR again once it has changed, and leaves the rest of the queue alone", () => {
    const q = queue(row(1), row(2, { updatedAt: "2026-10-02T00:00:00Z" }), row(3), row(4));
    const done = (_: string, n: number) => (n === 2 ? "2026-10-01T00:00:00Z" : "2026-10-01T00:00:00Z");
    expect(nextToPrepare(q, done)?.pr.number).toBe(2);
    expect(nextToPrepare(queue(row(1), row(2), row(3), row(4)), () => "2026-10-01T00:00:00Z")).toBeUndefined();
  });
});

describe("feedback through the UI's API", () => {
  it("says how close each useful or not useful brought a lesson", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { closeStores } = await import("@alden/core");
    const { createUiApi } = await import("./api.js");
    const home = mkdtempSync(join(tmpdir(), "alden-api-"));
    const saved = { home: process.env.ALDEN_HOME, track: process.env.DO_NOT_TRACK };
    process.env.ALDEN_HOME = home;
    process.env.DO_NOT_TRACK = "1";
    try {
      const api = createUiApi({ version: "test", cwd: home });
      const verdict = (number: number, checkId: string) =>
        api.addFeedback({
          kind: "verdict",
          target: { kind: "pr", repo: "acme/shop", number },
          briefingAt: "2026-10-01T00:00:00.000Z",
          item: { source: "check", checkId, title: "t", placement: "eyes" },
          verdict: "not_needed",
        }) as Promise<{ progress?: string }>;
      expect((await verdict(1, "signatures.changed")).progress).toBe(
        "1 of 3: 2 more not useful on API change flags (public signature and caller flags count together) and Alden will quieten them.",
      );
      expect((await verdict(2, "callers.outside")).progress).toMatch(/^2 of 3: one more not useful/);
      expect((await verdict(3, "callers.outside")).progress).toBe(
        "3 of 3 not useful on API change flags (public signature and caller flags count together): Alden quietens them in this repo.",
      );
    } finally {
      closeStores();
      process.env.ALDEN_HOME = saved.home;
      if (saved.home === undefined) delete process.env.ALDEN_HOME;
      if (saved.track === undefined) delete process.env.DO_NOT_TRACK;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
