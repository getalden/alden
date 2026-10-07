import type { AldenStore, GitHubClient } from "@alden/core";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  recorded: [] as { signal: string }[],
  tracked: [] as [string, Record<string, unknown>][],
}));

vi.mock("@alden/core", async (original) => ({
  ...(await original<typeof import("@alden/core")>()),
  checkOutcomes: async () => ({ checked: 1, failed: 0, recorded: state.recorded }),
  track: async (event: string, properties: Record<string, unknown>) => {
    state.tracked.push([event, properties]);
  },
}));

const { checkSentOutcomes } = await import("./outcomes.js");

describe("checking what came of the comments you sent", () => {
  it("counts new outcomes in usage stats by kind, as from outcomes, and nothing when there are none", async () => {
    const client = {} as GitHubClient;
    const store = {} as AldenStore;
    await checkSentOutcomes(client, store);
    expect(state.tracked).toEqual([]);
    state.recorded = [{ signal: "applied" }, { signal: "resolved" }, { signal: "resolved" }];
    expect((await checkSentOutcomes(client, store)).recorded).toHaveLength(3);
    expect(state.tracked).toEqual([
      [
        "review_signals",
        expect.objectContaining({ source: "outcome", applied: 1, resolved: 2, comment: 0, silent_pass: 0 }),
      ],
    ]);
  });
});
