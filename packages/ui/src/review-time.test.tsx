// @vitest-environment jsdom
import type { ReviewTimeGroup, ReviewTimeStats } from "@alden/schema";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewTimeSection } from "./components/StatsView";
import {
  ActiveClock,
  flushActiveTime,
  IDLE_MS,
  REPORT_EVERY_MS,
  ReviewTimeContext,
  useActiveTime,
} from "./review-time";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SEC = 1000;

describe("ActiveClock", () => {
  it("counts the time between moments of activity, leaving out idle stretches over 2 minutes entirely", () => {
    const clock = new ActiveClock();
    clock.activity(0);
    clock.activity(30 * SEC);
    clock.activity(90 * SEC);
    expect(clock.take()).toBe(90 * SEC);
    clock.activity(90 * SEC + IDLE_MS + SEC); // away for over 2 minutes: none of it counts
    clock.activity(90 * SEC + IDLE_MS + 11 * SEC);
    expect(clock.take()).toBe(10 * SEC);
    expect(clock.take()).toBe(0);
  });

  it("stops counting when paused, until the next activity", () => {
    const clock = new ActiveClock();
    clock.activity(0);
    clock.pause(20 * SEC);
    clock.activity(10 * 60 * SEC); // back in front of you: starts again from here
    clock.activity(10 * 60 * SEC + 5 * SEC);
    expect(clock.take()).toBe(25 * SEC);
  });
});

function Pane({ pr }: { pr: string | undefined }) {
  useActiveTime(pr);
  return null;
}

describe("useActiveTime", () => {
  it("reports active time on a PR while it's in front of you, and before a send", async () => {
    vi.useFakeTimers({ now: 0 });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const reports: [string, number][] = [];
    const report = async (pr: string, ms: number) => reports.push([pr, ms]);
    const { unmount } = render(
      <ReviewTimeContext.Provider value={report}>
        <Pane pr="acme/api#1" />
      </ReviewTimeContext.Provider>,
    );
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(4 * SEC);
      fireEvent.keyDown(window, { key: "j" });
    }
    await act(async () => {
      vi.advanceTimersByTime(REPORT_EVERY_MS); // reports at 15 s
    });
    expect(reports).toEqual([["acme/api#1", 12 * SEC]]);

    // Reading without input, then sending: the time since the last key counts (under 2 minutes).
    vi.advanceTimersByTime(4 * SEC);
    await act(() => flushActiveTime("Acme/API#1"));
    expect(reports.at(-1)).toEqual(["acme/api#1", 19 * SEC]);

    // Out of focus: nothing counts.
    vi.mocked(document.hasFocus).mockReturnValue(false);
    fireEvent.blur(window);
    vi.advanceTimersByTime(60 * SEC);
    fireEvent.keyDown(window, { key: "j" });
    await act(async () => {
      vi.advanceTimersByTime(REPORT_EVERY_MS);
    });
    unmount();
    expect(reports.reduce((sum, [, ms]) => sum + ms, 0)).toBe(31 * SEC);
  });

  it("measures nothing without a PR, or without the local API", () => {
    vi.useFakeTimers({ now: 0 });
    const report = vi.fn(async () => {});
    render(
      <ReviewTimeContext.Provider value={report}>
        <Pane pr={undefined} />
      </ReviewTimeContext.Provider>,
    );
    render(<Pane pr="acme/api#1" />);
    fireEvent.keyDown(window, { key: "j" });
    vi.advanceTimersByTime(REPORT_EVERY_MS * 2);
    expect(report).not.toHaveBeenCalled();
  });
});

const group = (count: number, active: number | null, wall: number | null, estimated = 0): ReviewTimeGroup => ({
  count,
  activeMedianMinutes: active,
  wallMedianMinutes: wall,
  estimated,
  small: count < 10,
});
const stats: ReviewTimeStats = {
  schemaVersion: 1,
  generatedAt: "2026-10-01T00:00:00.000Z",
  enabled: true,
  horizonHours: 72,
  windows: [14, 30, 90].map((days) => ({
    days,
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-10-01T00:00:00.000Z",
    all: group(days === 90 ? 26 : 7, null, null, days === 90 ? 2 : 0),
    withModel: days === 90 ? group(14, 10, 80) : group(4, 12, 130),
    withoutModel: days === 90 ? group(12, 7.5, 4320, 2) : group(3, 9, 50),
    excluded: { tooRecent: 2, notSent: days === 90 ? 5 : 1 },
  })),
};

describe("Time to review in Stats", () => {
  it("shows the two medians side by side, with sample sizes, and a note when they're few", () => {
    render(<ReviewTimeSection stats={stats} />);
    const rows = screen.getAllByRole("row").map((r) => r.textContent);
    expect(rows).toEqual([
      "Last 30 daysMedian activeMedian open to sendReviews",
      "With the model12m2h 10m4 · few",
      "Without the model9m50m3 · few",
    ]);
    expect(screen.getByText(/Few reviews \(under 10\)/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/faster|slower/);

    fireEvent.click(screen.getByRole("button", { name: "90 days" }));
    expect(screen.getAllByRole("row").map((r) => r.textContent)).toEqual([
      "Last 90 daysMedian activeMedian open to sendReviews",
      "With the model10m1h 20m14",
      "Without the model8m3d+12",
    ]);
    expect(screen.queryByText(/Few reviews/)).toBeNull();
    expect(screen.getByText(/5 briefings opened and never sent from Alden aren't counted/)).toBeTruthy();
    expect(screen.getByText(/2 reviews from a terminal or AI tool/)).toBeTruthy();
  });

  it("says when there's nothing to show, and when timing is off", () => {
    const empty = {
      ...stats,
      enabled: false,
      windows: stats.windows.map((w) => ({
        ...w,
        all: group(0, null, null),
        withModel: group(0, null, null),
        withoutModel: group(0, null, null),
        excluded: { tooRecent: 0, notSent: 0 },
      })),
    };
    render(<ReviewTimeSection stats={empty} />);
    expect(screen.getByText(/Off: Alden isn't recording/)).toBeTruthy();
    expect(screen.getByText(/No reviews timed yet/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
