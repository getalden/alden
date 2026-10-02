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
