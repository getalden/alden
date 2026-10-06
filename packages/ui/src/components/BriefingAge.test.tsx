// @vitest-environment jsdom
import type { Briefing, BriefingFreshness, BriefingTarget } from "@alden/schema";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BriefingAge, briefedAgo, staleText } from "./BriefingAge";

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

describe("staleText and briefedAgo", () => {
  it("says what moved since, in a few words", () => {
    expect(staleText({ state: "base_moved", baseRef: "main", commits: 4 })).toBe("main has 4 new commits since");
    expect(staleText({ state: "base_moved", baseRef: "main", commits: 1 })).toBe("main has 1 new commit since");
    expect(staleText({ state: "base_moved", baseRef: "main" })).toBe("main has moved since");
    expect(staleText({ state: "pr_changed", commits: 2 })).toBe("the PR has 2 new commits");
    expect(staleText({ state: "pr_changed" })).toBe("the PR has changed since");
    expect(staleText({ state: "fresh" })).toBeUndefined();
    expect(staleText({ state: "unknown", reason: "old" })).toBeUndefined();
  });

  it("says how long ago it was briefed", () => {
    const at = Date.parse("2026-10-06T09:00:00Z");
    expect(briefedAgo("2026-10-06T09:00:00Z", at + 20_000)).toBe("Briefed just now");
    expect(briefedAgo("2026-10-06T09:00:00Z", at + 30 * 60_000)).toBe("Briefed 30 min ago");
  });
});

describe("BriefingAge", () => {
  it("checks when shown, offers Re-brief when stale, and checks again on focus at most once a minute", async () => {
    let now = Date.parse("2026-10-06T09:30:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const answers: BriefingFreshness[] = [{ state: "fresh" }, { state: "base_moved", baseRef: "main", commits: 4 }];
    const check = vi.fn(async (_: BriefingTarget): Promise<BriefingFreshness> => answers.shift() ?? { state: "fresh" });
    const onRebrief = vi.fn();
    render(<BriefingAge briefing={briefing} check={check} onRebrief={onRebrief} />);

    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status").textContent).toBe("Briefed 30 min ago");
    expect(screen.queryByRole("button", { name: "Re-brief" })).toBeNull();

    // Back within the minute: no request.
    act(() => {
      fireEvent.focus(window);
    });
    expect(check).toHaveBeenCalledTimes(1);

    now += 61_000;
    act(() => {
      fireEvent.focus(window);
    });
    await screen.findByRole("button", { name: "Re-brief" });
    expect(check).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenLastCalledWith(briefing.target);
    expect(screen.getByRole("status").textContent).toBe("Briefed 31 min ago · main has 4 new commits since ·Re-brief");
    fireEvent.click(screen.getByRole("button", { name: "Re-brief" }));
    expect(onRebrief).toHaveBeenCalledTimes(1);
  });

  it("says only when it was briefed when GitHub can't be asked", async () => {
    const check = vi.fn(async () => {
      throw new Error("offline");
    });
    render(<BriefingAge briefing={briefing} check={check} onRebrief={() => {}} />);
    await waitFor(() => expect(check).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Re-brief" })).toBeNull();
  });
});
