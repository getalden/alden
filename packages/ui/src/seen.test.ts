import { afterEach, describe, expect, it, vi } from "vitest";
import { SEEN_BATCH_MS, type SeenBatch, SeenBatcher } from "./seen";

afterEach(() => vi.useRealTimers());

const place = (path: string, line?: number) => ({ path, ...(line ? { line } : {}), how: "diff" as const });

describe("SeenBatcher", () => {
  it("sends places a moment after the last one, a PR and head at a time, each place once", () => {
    vi.useFakeTimers();
    const posts: SeenBatch[] = [];
    const seen = new SeenBatcher(async (batch) => posts.push(batch));
    seen.record("acme/api#1", "h1", place("a.ts", 1));
    vi.advanceTimersByTime(SEEN_BATCH_MS - 1);
    seen.record("acme/api#1", "h1", place("b.ts"));
    seen.record("Acme/API#1", "h1", place("a.ts", 1));
    seen.record("acme/api#1", "h2", place("a.ts", 1));
    seen.record("acme/api#2", "h1", place("a.ts", 1));
    vi.advanceTimersByTime(SEEN_BATCH_MS - 1);
    expect(posts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(posts).toEqual([
      { pr: "acme/api#1", headSha: "h1", places: [place("a.ts", 1), place("b.ts")] },
      { pr: "acme/api#1", headSha: "h2", places: [place("a.ts", 1)] },
      { pr: "acme/api#2", headSha: "h1", places: [place("a.ts", 1)] },
    ]);
    // Seen again later: already sent.
    seen.record("acme/api#1", "h1", place("a.ts", 1));
    vi.advanceTimersByTime(SEEN_BATCH_MS);
    expect(posts).toHaveLength(3);
  });

  it("sends at most 50 places a request, and ignores errors", async () => {
    const posts: SeenBatch[] = [];
    const seen = new SeenBatcher(async (batch) => {
      posts.push(batch);
      throw new Error("offline");
    });
    for (let i = 1; i <= 60; i++) seen.record("acme/api#1", "h1", place("a.ts", i));
    seen.flush();
    expect(posts.map((p) => p.places.length)).toEqual([50, 10]);
    const throwing = new SeenBatcher(() => {
      throw new Error("no fetch");
    });
    throwing.record("acme/api#1", "h1", place("a.ts"));
    expect(() => throwing.flush()).not.toThrow();
    await Promise.resolve();
  });
});
