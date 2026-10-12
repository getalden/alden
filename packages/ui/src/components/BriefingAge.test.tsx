// @vitest-environment jsdom
import type { Briefing, BriefingFreshness, BriefingTarget } from "@alden/schema";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BriefingAge, briefedAgo, staleShort, staleText } from "./BriefingAge";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const briefing = {
  schemaVersion: 1,
  target: {
    kind: "pr",
    repo: "acme/app",
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    title: "T",
    author: "sam",
    baseRef: "main",
    headRef: "feature",
    headSha: "h1",
    baseSha: "b1",
    graphFrom: "merge",
  },
  generatedAt: "2026-10-06T09:00:00.000Z",
} as unknown as Briefing;

describe("staleText, staleShort and briefedAgo", () => {
  it("says what moved since, in a sentence and in a few characters", () => {
    expect(staleText({ state: "base_moved", baseRef: "main", commits: 4 })).toBe("main has 4 new commits since");
    expect(staleText({ state: "base_moved", baseRef: "main", commits: 1 })).toBe("main has 1 new commit since");
    expect(staleText({ state: "base_moved", baseRef: "main" })).toBe("main has moved since");
    expect(staleText({ state: "pr_changed", commits: 2 })).toBe("the PR has 2 new commits");
    expect(staleText({ state: "pr_changed" })).toBe("the PR has changed since");
    expect(staleText({ state: "fresh" })).toBeUndefined();
    expect(staleText({ state: "unknown", reason: "old" })).toBeUndefined();
    expect(staleShort({ state: "base_moved", baseRef: "main", commits: 4 })).toBe("main +4 commits");
    expect(staleShort({ state: "base_moved", baseRef: "main" })).toBe("main moved");
    expect(staleShort({ state: "pr_changed", commits: 1 })).toBe("PR +1 commit");
    expect(staleShort({ state: "pr_changed" })).toBe("PR changed");
    expect(staleShort({ state: "fresh" })).toBeUndefined();
  });

  it("says how long ago it was briefed", () => {
    const at = Date.parse("2026-10-06T09:00:00Z");
    expect(briefedAgo("2026-10-06T09:00:00Z", at + 20_000)).toBe("briefed just now");
    expect(briefedAgo("2026-10-06T09:00:00Z", at + 30 * 60_000)).toBe("briefed 30m ago");
    expect(briefedAgo("2026-10-06T09:00:00Z", at + 3 * 3_600_000)).toBe("briefed 3h ago");
  });
});

describe("BriefingAge", () => {
  it("checks when shown, says what moved, and checks again on focus at most once a minute", async () => {
    let now = Date.parse("2026-10-06T09:30:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const answers: BriefingFreshness[] = [{ state: "fresh" }, { state: "base_moved", baseRef: "main", commits: 4 }];
    const check = vi.fn(async (_: BriefingTarget): Promise<BriefingFreshness> => answers.shift() ?? { state: "fresh" });
    render(<BriefingAge briefing={briefing} check={check} />);

    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status").textContent).toBe("briefed 30m ago");

    // Back within the minute: no request.
    act(() => {
      fireEvent.focus(window);
    });
    expect(check).toHaveBeenCalledTimes(1);

    now += 61_000;
    act(() => {
      fireEvent.focus(window);
    });
    await screen.findByText("main +4 commits");
    expect(check).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenLastCalledWith(briefing.target);
    expect(screen.getByRole("status").textContent).toBe("briefed 31m ago · main +4 commits");
    expect(screen.getByRole("status").title).toBe("main has 4 new commits since");
  });

  it("says only when it was briefed when GitHub can't be asked", async () => {
    const check = vi.fn(async () => {
      throw new Error("offline");
    });
    render(<BriefingAge briefing={briefing} check={check} />);
    await waitFor(() => expect(check).toHaveBeenCalled());
    expect(screen.getByRole("status").textContent).toMatch(/^briefed /);
    expect(screen.getByRole("status").textContent).not.toContain("·");
  });
});
