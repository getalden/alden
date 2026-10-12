// @vitest-environment jsdom
import type { Briefing, PrDiff } from "@alden/schema";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDiffCache, commentPlace, placeMarkers, placeOrder, rangeRows } from "../diff";
import { forgetProgress } from "../guided";
import { SeenContext } from "../seen";
import { DiffPane, DiffView } from "./DiffView";
import { ReviewPane } from "./ReviewPane";

afterEach(() => {
  cleanup();
  clearDiffCache();
  forgetProgress();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const diff: PrDiff = {
  headSha: "h1",
  files: [
    {
      path: "src/charge.ts",
      status: "modified",
      additions: 3,
      deletions: 1,
      hunks: [
        {
          header: "@@ -1,4 +1,6 @@ export function charge(",
          lines: [
            { kind: "ctx", oldLine: 1, newLine: 1, text: "export function charge(amount: number) {" },
            { kind: "del", oldLine: 2, text: "  return pay(amount);" },
            { kind: "add", newLine: 2, text: "  const cents = Math.round(amount * 100);" },
            { kind: "add", newLine: 3, text: "  log(cents);" },
            { kind: "add", newLine: 4, text: "  return pay(cents);" },
            { kind: "ctx", oldLine: 3, newLine: 5, text: "}" },
          ],
        },
        {
          header: "@@ -20,2 +22,2 @@",
          lines: [
            { kind: "ctx", oldLine: 20, newLine: 22, text: "export const fee = 1;" },
            { kind: "ctx", oldLine: 21, newLine: 23, text: "export const tax = 2;" },
          ],
        },
      ],
    },
    { path: "src/new-name.ts", previousPath: "src/old-name.ts", status: "renamed", hunks: [] },
    { path: "logo.png", status: "modified", binary: true, hunks: [] },
    { path: "data/huge.json", status: "modified", additions: 90000, deletions: 3, patchMissing: true, hunks: [] },
  ],
};

const RIGHT = (line: number) => ({ path: "src/charge.ts", line, side: "RIGHT" as const });
const plusFor = (name: string) => screen.getByRole("button", { name });

describe("the diff's logic", () => {
  it("makes a range only on one side of one hunk", () => {
    expect(commentPlace(diff, { file: 0, hunk: 0, row: 4 }, { file: 0, hunk: 0, row: 2 })).toEqual({
      ...RIGHT(4),
      startLine: 2,
    });
    // Old side and new side: just the line picked last.
    expect(commentPlace(diff, { file: 0, hunk: 0, row: 3 }, { file: 0, hunk: 0, row: 1 })).toEqual(RIGHT(3));
    // Across hunks: the same.
    expect(commentPlace(diff, { file: 0, hunk: 1, row: 0 }, { file: 0, hunk: 0, row: 2 })).toEqual(RIGHT(22));
    expect(commentPlace(diff, { file: 0, hunk: 0, row: 1 })).toEqual({ path: "src/charge.ts", line: 2, side: "LEFT" });
    // Context lines count on the new side, so a range can run from context into added lines.
    expect(rangeRows(diff, { file: 0, hunk: 0, row: 0 }, { file: 0, hunk: 0, row: 3 })).toEqual(
      new Set(["0:0:0", "0:0:2", "0:0:3"]),
    );
  });

  it("puts places and drafts on their rows, or on the file when the line isn't shown", () => {
    const markers = placeMarkers(
      diff,
      [
        { path: "src/charge.ts", line: 3, title: "Logs cents", index: 1 },
        { path: "src/charge.ts", line: 99, title: "Far away", index: 2 },
        { path: "nowhere.ts", line: 1, title: "Not in the diff", index: 3 },
      ],
      [
        { path: "src/charge.ts", line: 2, side: "LEFT", body: "Why remove?", source: "you", state: "draft" },
        { body: "General note", source: "you", state: "draft" },
      ],
    );
    expect(markers.rows.get("0:0:3")?.places.map((p) => p.index)).toEqual([1]);
    expect(markers.rows.get("0:0:1")?.drafts.map((d) => d.body)).toEqual(["Why remove?"]);
    expect(markers.files.get(0)?.places.map((p) => p.index)).toEqual([2]);
    expect(
      placeOrder(diff, [
        { path: "src/charge.ts", line: 22, title: "b", index: 2 },
        { path: "src/charge.ts", line: 3, title: "a", index: 1 },
      ]).map((p) => p.place.index),
    ).toEqual([1, 2]);
  });
});

describe("DiffView", () => {
  it("shows each file with its counts, renames, notices, line numbers and hunks", () => {
    const { container } = render(<DiffView diff={diff} prUrl="https://github.com/acme/api/pull/1" />);
    expect(screen.getByText(/^file \d+ of 4$/)).toBeTruthy();
    const charge = screen.getByRole("region", { name: "src/charge.ts" });
    expect(within(charge).getByText("+3")).toBeTruthy();
    expect(within(charge).getByText("−1")).toBeTruthy();
    expect(within(charge).getByText("@@ -1,4 +1,6 @@ export function charge(")).toBeTruthy();
    const row = container.querySelector('[data-row="0:0:1"]') as HTMLElement;
    expect(row.className).toContain("del");
    expect(row.textContent).toContain("Removed:");
    expect([...row.querySelectorAll(".ln")].map((c) => c.textContent)).toEqual(["2", ""]);
    const renamed = screen.getByRole("region", { name: "src/new-name.ts" });
    expect(renamed.textContent).toContain("src/old-name.ts");
    expect(renamed.textContent).toContain("renamed to");
    expect(renamed.textContent).toContain("Moved without changes.");
    expect(screen.getByRole("region", { name: "logo.png" }).textContent).toContain("A binary file.");
    expect(screen.getByRole("region", { name: "data/huge.json" }).textContent).toContain("too large for GitHub");
    // No one takes comments yet: no + on the lines.
    expect(container.querySelectorAll(".diff-plus")).toHaveLength(0);
  });

  it("collapses a file from its header or with f, and starts big files collapsed with Show", () => {
    const { container } = render(<DiffView diff={diff} collapseOver={5} />);
    const toggle = screen.getByRole("button", { name: /src\/charge\.ts/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText(/8 lines of diff, collapsed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-row="0:0:0"]')).toBeTruthy();
    toggle.focus();
    fireEvent.keyDown(toggle, { key: "f" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("calls onComment for a line, a shift-clicked range and a dragged range, on one side of one hunk", () => {
    const onComment = vi.fn();
    const { container } = render(<DiffView diff={diff} onComment={onComment} />);
    fireEvent.click(plusFor("Comment on line 2"));
    expect(onComment).toHaveBeenLastCalledWith(RIGHT(2));
    fireEvent.click(plusFor("Comment on line 4"), { shiftKey: true });
    expect(onComment).toHaveBeenLastCalledWith({ ...RIGHT(4), startLine: 2 });
    expect([...container.querySelectorAll("tr.sel")].map((r) => r.getAttribute("data-row"))).toEqual([
      "0:0:2",
      "0:0:3",
      "0:0:4",
    ]);
    // The removed line is on the other side: just that line.
    fireEvent.click(plusFor("Comment on removed line 2"), { shiftKey: true });
    expect(onComment).toHaveBeenLastCalledWith({ path: "src/charge.ts", line: 2, side: "LEFT" });

    // A drag from line 5 up to line 1, with the mouse.
    fireEvent.mouseDown(plusFor("Comment on line 5"), { button: 0 });
    fireEvent.mouseMove(container.querySelector('[data-row="0:0:0"] .code') as Element);
    expect(container.querySelectorAll("tr.sel").length).toBeGreaterThan(1);
    fireEvent.mouseUp(window);
    expect(onComment).toHaveBeenLastCalledWith({ ...RIGHT(5), line: 5, startLine: 1 });
    // Into another hunk, the drag stays where it was.
    fireEvent.mouseDown(plusFor("Comment on line 22"), { button: 0 });
    fireEvent.mouseMove(container.querySelector('[data-row="0:0:0"] .code') as Element);
    fireEvent.mouseUp(window);
    expect(onComment).toHaveBeenLastCalledWith(RIGHT(22));
    expect(onComment).toHaveBeenCalledTimes(5);
  });

  it("shows places and drafts under their lines, folds a place, and sums them up in the file's header", () => {
    const { container } = render(
      <DiffView
        diff={diff}
        places={[
          { path: "src/charge.ts", line: 3, title: "Logs the amount in cents", index: 1 },
          { path: "logo.png", title: "A new logo", index: 2 },
        ]}
        drafts={[
          { path: "src/charge.ts", line: 4, body: "Keep this?", source: "you", state: "draft" },
          { path: "src/charge.ts", line: 4, body: "Agreed.", source: "claude", state: "outdated" },
        ]}
      />,
    );
    // Under its line, a card for each place and each draft, saying who it's from.
    const place = screen.getByRole("button", { name: "Place E1: Logs the amount in cents" });
    expect(place.closest("tr")?.previousElementSibling?.getAttribute("data-row")).toBe("0:0:3");
    const card = place.closest(".v3-dcard") as HTMLElement;
    expect(card.textContent).toContain("Logs the amount in cents");
    // Its label folds it to one line.
    expect(place.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(place);
    expect(place.getAttribute("aria-expanded")).toBe("false");
    expect(card.querySelector(".v3-dcard-body")).toBeNull();
    const notes = container.querySelector('[data-notes-for="0:0:4"]')?.textContent ?? "";
    expect(notes).toContain("you · draft");
    expect(notes).toContain("Keep this?");
    expect(notes).toContain("Claude Code · outdated");
    expect(notes).toContain("Agreed.");
    // The file's header sums them up.
    const head = within(screen.getByRole("region", { name: "src/charge.ts" })).getByRole("banner");
    expect(head.querySelector(".diff-file-meta")?.textContent).toBe("E1 · 2 drafts");
    // A place on a whole file sits in its header.
    expect(within(screen.getByRole("region", { name: "logo.png" })).getByText("E2")).toBeTruthy();
  });

  it("goes from place to place with ] and [, without the window's own [ hearing it", () => {
    const windowKeys = vi.fn();
    window.addEventListener("keydown", windowKeys);
    const { container } = render(
      <DiffView
        diff={diff}
        places={[
          { path: "src/charge.ts", line: 23, title: "Tax", index: 2 },
          { path: "src/charge.ts", line: 3, title: "Cents", index: 1 },
        ]}
      />,
    );
    const highlighted = () => container.querySelector("tr.hl")?.getAttribute("data-row");
    fireEvent.keyDown(document.body, { key: "]" });
    expect(highlighted()).toBe("0:0:3");
    expect(document.activeElement?.textContent).toBe("E1");
    fireEvent.keyDown(document.body, { key: "]" });
    expect(highlighted()).toBe("0:1:1");
    fireEvent.keyDown(document.body, { key: "]" });
    expect(highlighted()).toBe("0:0:3");
    fireEvent.keyDown(document.body, { key: "[" });
    expect(highlighted()).toBe("0:1:1");
    expect(screen.getByRole("status", { hidden: true }).textContent).toContain("E2, 2 of 2: Tax");
    expect(windowKeys).not.toHaveBeenCalled();
    // Not while typing.
    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "]" });
    expect(highlighted()).toBe("0:1:1");
    input.remove();
    window.removeEventListener("keydown", windowKeys);
  });

  it("scrolls to a focus it's given, opening its file, and says when the line isn't in the diff", () => {
    const { container, rerender } = render(
      <DiffView diff={diff} collapseOver={5} focus={{ path: "src/charge.ts", line: 4 }} />,
    );
    expect(container.querySelector("tr.hl")?.getAttribute("data-row")).toBe("0:0:4");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    rerender(<DiffView diff={diff} collapseOver={5} focus={{ path: "src/charge.ts", line: 50 }} />);
    expect(screen.getByText("Line 50 of src/charge.ts isn't in the diff; showing the file.")).toBeTruthy();
    rerender(<DiffView diff={diff} collapseOver={5} focus={{ path: "nope.ts" }} />);
    expect(screen.getByText("nope.ts isn't in this diff.")).toBeTruthy();
  });

  it("renders rows only as they near the screen", () => {
    const observers: {
      callback: IntersectionObserverCallback;
      targets: Element[];
      options?: IntersectionObserverInit | undefined;
    }[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        targets: Element[] = [];
        constructor(
          readonly callback: IntersectionObserverCallback,
          readonly options?: IntersectionObserverInit,
        ) {
          observers.push(this);
        }
        observe(el: Element) {
          this.targets.push(el);
        }
        disconnect() {}
      },
    );
    const lines = Array.from({ length: 300 }, (_, i) => ({ kind: "add" as const, newLine: i + 1, text: `line ${i}` }));
    const big: PrDiff = {
      headSha: "h",
      files: [{ path: "big.ts", status: "added", hunks: [{ header: "@@ -0,0 +1,300 @@", lines }] }],
    };
    const { container } = render(<DiffView diff={big} />);
    expect(container.querySelectorAll("tr.dl")).toHaveLength(0);
    expect(container.querySelectorAll("tr.diff-placeholder")).toHaveLength(3);
    // The first run of rows (the file's own observer only says which file is on screen).
    const first = observers.find((o) => o.options?.rootMargin === "800px 0px");
    act(() =>
      first?.callback(
        [{ isIntersecting: true, target: first.targets[0] } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    expect(container.querySelectorAll("tr.dl").length).toBeGreaterThan(100);
    expect(container.querySelectorAll("tr.diff-placeholder")).toHaveLength(2);
    // Jumping to a line renders its rows at once.
    act(() => fireEvent.keyDown(document.body, { key: "]" }));
    expect(screen.getByText("No places to look in this diff.")).toBeTruthy();
  });
});

describe("DiffPane", () => {
  it("loads a PR's diff once per head, and points out a newer head than the briefing's", async () => {
    const load = vi.fn(async () => diff);
    const first = render(<DiffPane load={load} pr="acme/api#1" headSha="h1" />);
    expect(screen.getByText("Loading the diff…")).toBeTruthy();
    await screen.findByText(/^file \d+ of 4$/);
    first.unmount();
    render(<DiffPane load={load} pr="acme/api#1" headSha="h1" />);
    await screen.findByText(/^file \d+ of 4$/);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("acme/api#1");
    expect(screen.queryByText(/new commits since this briefing/)).toBeNull();
    cleanup();
    render(<DiffPane load={load} pr="acme/api#1" headSha="h0" />);
    await screen.findByText(/new commits since this briefing/);
  });

  it("says why it didn't load, and tries again", async () => {
    const load = vi
      .fn<(pr?: string) => Promise<PrDiff>>()
      .mockRejectedValueOnce(new Error("Not signed in to GitHub."))
      .mockResolvedValue({ headSha: "h", files: [] });
    render(<DiffPane load={load} />);
    await screen.findByText("Not signed in to GitHub.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Nothing has changed");
    expect(load).toHaveBeenCalledWith(undefined);
  });
});

describe("DiffPane since your review", () => {
  const narrow: PrDiff = {
    ...diff,
    files: diff.files.slice(0, 1),
    since: { base: "abc1234def", applied: true },
  };
  const loader = (since: PrDiff) =>
    vi.fn(async (_pr?: string, base?: string): Promise<PrDiff> => (base ? since : diff));

  it("starts on the changes since the commit you reviewed, and switches to the whole PR", async () => {
    const load = loader(narrow);
    render(<DiffPane load={load} pr="acme/api#1" headSha="h1" since="abc1234def" />);
    await screen.findByText(/^file \d+ of 1$/);
    expect(load).toHaveBeenLastCalledWith("acme/api#1", "abc1234def");
    expect(screen.getByRole("button", { name: "Since your review" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("abc1234")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Whole PR" }));
    await screen.findByText(/^file \d+ of 4$/);
    expect(load).toHaveBeenLastCalledWith("acme/api#1");
    // Back again: from the cache.
    fireEvent.click(screen.getByRole("button", { name: "Since your review" }));
    await screen.findByText(/^file \d+ of 1$/);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("offers nothing on a PR you haven't reviewed, or on local changes", async () => {
    render(<DiffPane load={loader(narrow)} pr="acme/api#1" headSha="h1" />);
    await screen.findByText(/^file \d+ of 4$/);
    expect(screen.queryByRole("button", { name: "Whole PR" })).toBeNull();
    cleanup();
    render(<DiffPane load={loader(narrow)} since="abc1234def" />);
    await screen.findByText(/^file \d+ of 4$/);
    expect(screen.queryByRole("button", { name: "Whole PR" })).toBeNull();
  });

  it("says when the commit you reviewed is gone and it's the whole PR, or when nothing is new", async () => {
    render(
      <DiffPane
        load={loader({ ...diff, since: { base: "abc1234def", applied: false } })}
        pr="acme/api#1"
        headSha="h1"
        since="abc1234def"
      />,
    );
    await screen.findByText(/isn't in this PR's history any more/);
    expect(screen.getByText(/^file \d+ of 4$/)).toBeTruthy();
    cleanup();
    clearDiffCache();
    render(<DiffPane load={loader({ ...narrow, files: [] })} pr="acme/api#1" headSha="h1" since="abc1234def" />);
    await screen.findByText("Nothing new since your review");
    expect(screen.getByRole("button", { name: "Whole PR" })).toBeTruthy();
  });

  it("marks only the new side's comments, and keeps removed lines for the whole PR", async () => {
    const onComment = vi.fn();
    const drafts = [
      { path: "src/charge.ts", line: 3, side: "RIGHT", body: "Log the currency too", source: "you", state: "draft" },
      { path: "src/charge.ts", line: 2, side: "LEFT", body: "Why was this removed?", source: "you", state: "draft" },
    ];
    render(
      <DiffPane
        load={loader(narrow)}
        pr="acme/api#1"
        headSha="h1"
        since="abc1234def"
        drafts={drafts}
        onComment={onComment}
      />,
    );
    await screen.findByText(/^file \d+ of 1$/);
    expect(screen.getByText("Log the currency too")).toBeTruthy();
    expect(screen.queryByText("Why was this removed?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Comment on removed line 2" }));
    expect(onComment).not.toHaveBeenCalled();
    expect(screen.getByText("To comment on a removed line, switch to Whole PR.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Comment on line 3" }));
    expect(onComment).toHaveBeenCalledWith({ path: "src/charge.ts", line: 3, side: "RIGHT" });
  });
});

const briefing = {
  schemaVersion: 1,
  target: {
    kind: "pr",
    repo: "acme/api",
    number: 1,
    url: "https://github.com/acme/api/pull/1",
    title: "Cents",
    author: "sam",
    baseRef: "main",
    headRef: "cents",
    headSha: "h1",
  },
  generatedAt: "2026-10-01T10:00:00Z",
  summary: { files: 1, additions: 3, deletions: 1, reviewableAdditions: 3, reviewableDeletions: 1 },
  files: [
    {
      path: "src/charge.ts",
      status: "modified",
      kind: "code",
      additions: 3,
      deletions: 1,
      binary: false,
      patchMissing: false,
    },
  ],
  checks: [],
  needsYourEyes: [{ title: "Logs cents", reason: "A log of money.", anchor: { path: "src/charge.ts", line: 3 } }],
  notChecked: [],
} as unknown as Briefing;

function pane(loadDiff?: (pr?: string) => Promise<PrDiff>) {
  return (
    <ReviewPane
      crumbs={null}
      title="Cents"
      run={{ briefing, running: false, stages: [], startedAt: 0, request: {} } as never}
      controls={null}
      onStart={() => {}}
      onCancel={() => {}}
      request={{}}
      emptyHint=""
      loadDiff={loadDiff}
    />
  );
}

describe("the reading steps: Brief, Walk through, Diff", () => {
  it("switch with a click or d, are remembered for the window, and a place opens the diff there", async () => {
    const load = vi.fn(async () => diff);
    const { container, unmount } = render(pane(load));
    const briefTab = screen.getByRole("tab", { name: "Brief" });
    const diffTab = screen.getByRole("tab", { name: /^Diff/ });
    expect(screen.getByRole("tablist", { name: "Reading step" }).textContent).toBe("1Brief2Walk throughg3Diffd");
    expect(briefTab.getAttribute("aria-selected")).toBe("true");
    // The diff loads the first time its tab opens.
    expect(load).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "d" });
    expect(diffTab.getAttribute("aria-selected")).toBe("true");
    await screen.findByText(/^file \d+ of 4$/);
    expect(window.sessionStorage.getItem("alden.briefingTab")).toBe("diff");
    expect(screen.getByRole("button", { name: "Place E1: Logs cents" })).toBeTruthy();
    fireEvent.click(briefTab);
    expect((container.querySelector(".briefing-panel") as HTMLElement).hidden).toBe(false);
    expect((container.querySelector(".diff-panel") as HTMLElement).hidden).toBe(true);

    // The place's file:line opens the diff there; GitHub's link stays beside it.
    fireEvent.click(screen.getByRole("button", { name: "src/charge.ts:3" }));
    expect(diffTab.getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(container.querySelector("tr.hl")?.getAttribute("data-row")).toBe("0:0:3"));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "src/charge.ts:3 on GitHub", hidden: true })).toBeTruthy(),
    );
    unmount();

    // A new pane in the same window opens on the Diff tab.
    render(pane(load));
    expect(screen.getByRole("tab", { name: /^Diff/ }).getAttribute("aria-selected")).toBe("true");
    await screen.findByText(/^file \d+ of 4$/);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("walk through the places from the header, from g on the Diff tab, and back to the brief", async () => {
    const load = vi.fn(async () => diff);
    render(pane(load));
    const walk = screen.getByRole("tab", { name: /^Walk through/ });
    fireEvent.click(walk);
    await screen.findByText("Step 1 of 1");
    expect(walk.getAttribute("aria-selected")).toBe("true");

    // Brief leaves the walk; the briefing's list of places is back.
    fireEvent.click(screen.getByRole("tab", { name: "Brief" }));
    await waitFor(() => expect(screen.queryByText("Step 1 of 1")).toBeNull());
    expect(screen.getByRole("tab", { name: "Brief" }).getAttribute("aria-selected")).toBe("true");

    // g on the Diff tab walks through on the briefing.
    fireEvent.click(screen.getByRole("tab", { name: /^Diff/ }));
    await screen.findByText(/^file \d+ of 4$/);
    act(() => void fireEvent.keyDown(document.body, { key: "g" }));
    await screen.findByText("Step 1 of 1");
    expect(screen.getByRole("tab", { name: /^Walk through/ }).getAttribute("aria-selected")).toBe("true");
    expect((document.querySelector(".briefing-panel") as HTMLElement).hidden).toBe(false);
  });

  it("have no Diff without a way to load the diff", () => {
    render(pane());
    expect(screen.queryByRole("tab", { name: /Diff/ })).toBeNull();
    expect(screen.getByRole("tab", { name: "Brief" })).toBeTruthy();
    expect(screen.getByText("Logs cents.")).toBeTruthy();
  });
});

describe("what you saw in the diff", () => {
  type Fake = {
    callback: IntersectionObserverCallback;
    options: IntersectionObserverInit | undefined;
    targets: Element[];
    off: boolean;
  };
  let observers: Fake[];
  beforeEach(() => {
    observers = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        targets: Element[] = [];
        off = false;
        constructor(
          readonly callback: IntersectionObserverCallback,
          readonly options?: IntersectionObserverInit,
        ) {
          observers.push(this as unknown as Fake);
        }
        observe(el: Element) {
          this.targets.push(el);
        }
        disconnect() {
          this.off = true;
        }
      },
    );
  });
  afterEach(() => vi.useRealTimers());

  const fire = (o: Fake, isIntersecting: boolean) =>
    act(() =>
      o.callback(
        o.targets.map((target) => ({ isIntersecting, target }) as unknown as IntersectionObserverEntry),
        o as unknown as IntersectionObserver,
      ),
    );
  /** Renders every chunk of rows, as scrolling near them would. */
  const renderRows = () => {
    for (const o of observers.filter((o) => o.options?.rootMargin)) fire(o, true);
  };
  const markerObserver = (element: Element) =>
    observers.filter((o) => o.options?.threshold === 1 && !o.off && o.targets.includes(element)).at(-1) as Fake;
  const places = [
    { path: "src/charge.ts", line: 3, title: "Logs cents", index: 1, checkId: "money.cents" },
    { path: "src/charge.ts", line: 99, title: "Far away", index: 2 },
  ];

  it("counts a place once its marker has been in view for 1.5 s, once", () => {
    vi.useFakeTimers();
    const onSeen = vi.fn();
    render(<DiffView diff={diff} places={places} onSeen={onSeen} />);
    renderRows();
    const e1 = screen.getByRole("button", { name: "Place E1: Logs cents" });
    fire(markerObserver(e1), true);
    act(() => vi.advanceTimersByTime(1_000));
    // Scrolled past before it counted.
    fire(markerObserver(e1), false);
    act(() => vi.advanceTimersByTime(2_000));
    expect(onSeen).not.toHaveBeenCalled();
    fire(markerObserver(e1), true);
    act(() => vi.advanceTimersByTime(1_500));
    expect(onSeen.mock.calls).toEqual([[places[0]]]);
    expect(observers.some((o) => o.targets.includes(e1) && !o.off)).toBe(false);
    // E2 isn't on a line the diff shows: its marker is in the file's header, and it was never in view.
    expect(document.querySelector(".diff-file-meta .diff-place")?.textContent).toBe("E2");
    act(() => vi.advanceTimersByTime(5_000));
    expect(onSeen).toHaveBeenCalledTimes(1);
  });

  it("records a PR's places at the briefing's head, as seen in the diff, and never your local changes'", async () => {
    const record = vi.fn();
    const local = render(
      <SeenContext.Provider value={record}>
        <DiffPane load={async () => diff} places={places} />
      </SeenContext.Provider>,
    );
    await screen.findByText(/^file \d+ of 4$/);
    renderRows();
    expect(observers.some((o) => o.options?.threshold === 1)).toBe(false);
    local.unmount();
    clearDiffCache();

    render(
      <SeenContext.Provider value={record}>
        <DiffPane load={async () => diff} pr="acme/api#1" headSha="h0" places={places} />
      </SeenContext.Provider>,
    );
    await screen.findByText(/^file \d+ of 4$/);
    vi.useFakeTimers();
    renderRows();
    fire(markerObserver(screen.getByRole("button", { name: "Place E1: Logs cents" })), true);
    act(() => vi.advanceTimersByTime(1_500));
    expect(record.mock.calls).toEqual([
      ["acme/api#1", "h0", { checkId: "money.cents", path: "src/charge.ts", line: 3, how: "diff" }],
    ]);
  });

  it("counts nothing in a hidden tab, or without an IntersectionObserver", () => {
    vi.useFakeTimers();
    const onSeen = vi.fn();
    const hidden = render(
      <div hidden>
        <DiffView diff={diff} places={places} onSeen={onSeen} />
      </div>,
    );
    renderRows();
    fire(markerObserver(screen.getByRole("button", { name: "Place E1: Logs cents", hidden: true })), true);
    act(() => vi.advanceTimersByTime(5_000));
    expect(onSeen).not.toHaveBeenCalled();
    hidden.unmount();

    vi.unstubAllGlobals();
    render(<DiffView diff={diff} places={places} onSeen={onSeen} />);
    act(() => vi.advanceTimersByTime(5_000));
    expect(onSeen).not.toHaveBeenCalled();
  });
});
