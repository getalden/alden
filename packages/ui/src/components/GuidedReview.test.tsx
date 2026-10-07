// @vitest-environment jsdom
import type { Briefing, FeedbackItem } from "@alden/schema";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BriefingFeedback, Verdict } from "../feedback";
import { type CommentPlace, forgetProgress, type PrDiff } from "../guided";
import { SeenContext } from "../seen";
import { BriefingView } from "./BriefingView";

afterEach(() => {
  cleanup();
  forgetProgress();
});

const briefing: Briefing = {
  schemaVersion: 1,
  target: {
    kind: "pr",
    repo: "acme/api",
    number: 1,
    url: "https://github.com/acme/api/pull/1",
    title: "Change the charge API",
    author: "sam",
    baseRef: "main",
    headRef: "feature",
    headSha: "old0000",
  },
  generatedAt: "2026-10-07T10:00:00Z",
  summary: { files: 2, additions: 4, deletions: 1, reviewableAdditions: 4, reviewableDeletions: 1 },
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
    {
      path: "src/web.ts",
      status: "modified",
      kind: "code",
      additions: 1,
      deletions: 0,
      binary: false,
      patchMissing: false,
    },
  ],
  checks: [
    {
      id: "signatures.changed",
      title: "Public API changes",
      status: "flagged",
      severity: "medium",
      summary: "1 changed.",
      evidence: [{ text: "changed: charge", anchor: { path: "src/charge.ts", line: 2 } }],
      heuristic: false,
    },
    {
      id: "callers.outside",
      title: "Callers outside the diff",
      status: "flagged",
      severity: "high",
      summary: "1 caller.",
      evidence: [{ text: "calls charge (signature changed)", anchor: { path: "src/api.ts", line: 9 } }],
      heuristic: true,
    },
  ],
  needsYourEyes: [
    {
      title: "Public API change in src/charge.ts",
      reason: "changed: charge. 1 changed.",
      anchor: { path: "src/charge.ts", line: 2 },
      checkId: "signatures.changed",
      related: [
        { path: "src/web.ts", line: 1, why: "caller" },
        { path: "src/api.ts", line: 9, why: "caller" },
        { path: "src/charge.test.ts", line: 4, why: "test" },
      ],
    },
    {
      title: "Caller of changed code in src/api.ts",
      reason: "calls charge (signature changed).",
      anchor: { path: "src/api.ts", line: 9 },
      checkId: "callers.outside",
    },
  ],
  notChecked: [],
  llm: {
    status: "ok",
    findings: [
      {
        title: "Retry loops",
        detail: "It never stops.",
        severity: "medium",
        anchors: [{ path: "src/web.ts", line: 1 }],
      },
    ],
    droppedFindings: 0,
    omittedFiles: [],
  },
};

const diff: PrDiff = {
  headSha: "head123",
  files: [
    {
      path: "src/charge.ts",
      status: "modified",
      hunks: [
        {
          header: "@@ -1,2 +1,3 @@",
          lines: [
            { kind: "ctx", oldLine: 1, newLine: 1, text: "import x" },
            { kind: "del", oldLine: 2, text: "export function charge(a) {" },
            { kind: "add", newLine: 2, text: "export function charge(a, b) {" },
            { kind: "ctx", oldLine: 3, newLine: 3, text: "}" },
          ],
        },
      ],
    },
    {
      path: "src/web.ts",
      status: "modified",
      hunks: [{ header: "@@ -0,0 +1 @@", lines: [{ kind: "add", newLine: 1, text: "charge(1, 2);" }] }],
    },
  ],
};

function fakeFeedback() {
  const verdicts = new Map<string, Verdict>();
  const toggle = vi.fn((item: FeedbackItem, verdict: Verdict) => {
    verdicts.set(item.title, verdict);
  });
  const feedback: BriefingFeedback = {
    verdictOf: (item) => verdicts.get(item.title),
    progressOf: () => undefined,
    toggle,
    reportMissed: async () => {},
    missedCount: 0,
    error: undefined,
  };
  return { feedback, toggle };
}

const key = (k: string, target: EventTarget = document.body) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });

function setup(guided: { onComment?: (p: CommentPlace) => void; onFinish?: () => void; fail?: boolean } = {}) {
  const loadDiff = vi.fn(async (_pr: string) => {
    if (guided.fail) throw new Error("GitHub said no");
    return diff;
  });
  const { feedback, toggle } = fakeFeedback();
  const view = render(
    <BriefingView
      briefing={briefing}
      feedback={feedback}
      guided={{
        loadDiff,
        ...(guided.onComment ? { onComment: guided.onComment } : {}),
        ...(guided.onFinish ? { onFinish: guided.onFinish } : {}),
      }}
    />,
  );
  return { loadDiff, toggle, view };
}

describe("guided review", () => {
  it("starts from its button, one step at a time, with the code at the place", async () => {
    const { loadDiff } = setup();
    expect(loadDiff).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Start guided review/ }));

    const heading = screen.getByRole("heading", { name: "Public API change in src/charge.ts" });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByText("Step 1 of 2")).toBeTruthy();
    expect(screen.getByText("changed: charge. 1 changed.")).toBeTruthy();
    expect(screen.getByText("signatures.changed")).toBeTruthy();
    expect(loadDiff).toHaveBeenCalledWith("acme/api#1");
    const code = await screen.findByRole("region", { name: "src/charge.ts, lines 1 to 3" });
    expect(within(code).getByText("export function charge(a, b) {")).toBeTruthy();
    expect(code.querySelector(".ex-focus")?.textContent).toContain("charge(a, b)");
    // The list of places makes way for the step.
    expect(screen.queryByRole("button", { name: /Start guided review/ })).toBeNull();
  });

  it("shows the files to look at too: excerpts for ones in the diff, GitHub at the head commit for the rest", async () => {
    setup();
    await key("g");
    await screen.findByRole("region", { name: "src/charge.ts, lines 1 to 3" });
    const step = within(screen.getByRole("region", { name: "Public API change in src/charge.ts" }));
    expect(step.getByRole("heading", { name: "Look at these too" })).toBeTruthy();

    const inDiff = screen.getByRole("button", { name: /src\/web.ts:1/ });
    expect(inDiff.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(inDiff);
    expect(inDiff.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("region", { name: "src/web.ts, lines 1 to 1" })).toBeTruthy();

    const outside = step.getByRole("link", { name: /src\/api.ts:9/ });
    expect(outside.getAttribute("href")).toBe("https://github.com/acme/api/blob/head123/src/api.ts#L9");
    expect(step.getByRole("link", { name: /src\/charge.test.ts:4/ }).getAttribute("href")).toBe(
      "https://github.com/acme/api/blob/head123/src/charge.test.ts#L4",
    );
    expect(step.getAllByText("caller")).toHaveLength(2);
    expect(step.getByText("test")).toBeTruthy();
  });

  it("moves with n and p, not while typing, and Esc leaves where you were", async () => {
    setup();
    await key("g");
    await key("n");
    expect(screen.getByText("Step 2 of 2")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Caller of changed code in src/api.ts" }));
    // Outside the diff: a link instead of code.
    expect(await screen.findByText(/This line isn't in the diff/)).toBeTruthy();

    await key("n");
    expect(screen.getByText("Extra 1 of 1 · from the model")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Retry loops" })).toBeTruthy();
    await key("n");
    expect(screen.getByText("Extra 1 of 1 · from the model")).toBeTruthy();

    const input = screen.getByRole("textbox", { name: "What should it have flagged?" });
    await key("p", input);
    expect(screen.getByText("Extra 1 of 1 · from the model")).toBeTruthy();
    await key("p");
    expect(screen.getByText("Step 2 of 2")).toBeTruthy();

    await key("Escape");
    expect(screen.queryByText("Step 2 of 2")).toBeNull();
    expect(screen.getByRole("button", { name: /Resume guided review at step 2/ })).toBeTruthy();
    expect(screen.getByText("calls charge (signature changed).")).toBeTruthy();
  });

  it("keeps your step while the PR is open", async () => {
    const { view } = setup();
    await key("g");
    await key("n");
    view.unmount();
    setup();
    expect(screen.getByText("Step 2 of 2")).toBeTruthy();
  });

  it("reacts with the briefing's buttons, and comments on the place when the drawer is there", async () => {
    const onComment = vi.fn();
    const { toggle } = setup({ onComment });
    await key("g");
    const step = screen.getByRole("region", { name: "Public API change in src/charge.ts" });
    fireEvent.click(within(step).getByRole("button", { name: "Useful" }));
    expect(toggle).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Public API change in src/charge.ts", placement: "eyes" }),
      "agree",
    );
    fireEvent.click(within(step).getByRole("button", { name: "Comment" }));
    expect(onComment).toHaveBeenCalledWith({ path: "src/charge.ts", line: 2, side: "RIGHT" });
  });

  it("comments on the model's extra steps too: a line outside the diff or a whole file goes in the review body", async () => {
    const onComment = vi.fn();
    const withExtras: Briefing = {
      ...briefing,
      llm: {
        status: "ok",
        findings: [
          {
            title: "Retry loops",
            detail: "It never stops.",
            severity: "medium",
            anchors: [{ path: "src/web.ts", line: 5 }],
          },
          {
            title: "Stale docs",
            detail: "The README is out of date.",
            severity: "low",
            anchors: [{ path: "README.md" }],
          },
        ],
        droppedFindings: 0,
        omittedFiles: [],
      },
    };
    render(<BriefingView briefing={withExtras} guided={{ loadDiff: async () => diff, onComment }} />);
    await key("g");
    await key("n");
    await key("n");
    const retry = screen.getByRole("region", { name: "Retry loops" });
    const comment = within(retry).getByRole("button", { name: "Comment" });
    await waitFor(() =>
      expect(comment.getAttribute("title")).toMatch(/Not in the PR's diff: it goes in the review body/),
    );
    fireEvent.click(comment);
    expect(onComment).toHaveBeenLastCalledWith({ path: "src/web.ts", line: 5, side: "RIGHT" });
    await key("n");
    fireEvent.click(
      within(screen.getByRole("region", { name: "Stale docs" })).getByRole("button", { name: "Comment" }),
    );
    expect(onComment).toHaveBeenLastCalledWith({ path: "README.md", side: "RIGHT" });
  });

  it("has no Comment without somewhere to write it", async () => {
    setup();
    await key("g");
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
  });

  it("offers to finish on the last of Alden's steps and on the last step", async () => {
    const onFinish = vi.fn();
    setup({ onFinish });
    await key("g");
    expect(screen.queryByRole("button", { name: "Finish: review your comments" })).toBeNull();
    await key("n");
    expect(screen.getByRole("button", { name: /Next: 1 more from the model/ })).toBeTruthy();
    await key("n");
    fireEvent.click(screen.getByRole("button", { name: "Finish: review your comments" }));
    expect(onFinish).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: /Start guided review/ })).toBeTruthy();
  });

  it("says when the diff couldn't be loaded, and links the place on GitHub", async () => {
    setup({ fail: true });
    await key("g");
    expect(await screen.findByText(/Couldn't load the diff: GitHub said no/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open it on GitHub ↗" }).getAttribute("href")).toBe(
      "https://github.com/acme/api/blob/old0000/src/charge.ts#L2",
    );
  });

  it("isn't offered when nothing needs your eyes", () => {
    render(<BriefingView briefing={{ ...briefing, needsYourEyes: [], llm: undefined }} />);
    expect(screen.queryByRole("button", { name: /guided review/ })).toBeNull();
  });

  it("works without a diff for local changes: the place, its reason and related files", async () => {
    render(
      <BriefingView
        briefing={{ ...briefing, target: { kind: "local", repoRoot: "/r", branch: "main" }, llm: undefined }}
      />,
    );
    await key("g");
    expect(screen.getByText("Step 1 of 2")).toBeTruthy();
    expect(screen.queryByText(/Loading the code/)).toBeNull();
    await waitFor(() => expect(screen.getByText("src/web.ts:1")).toBeTruthy());
  });
});

describe("what you saw in guided review", () => {
  afterEach(() => vi.useRealTimers());
  const seenIn = (b: Briefing, hidden = false) => {
    vi.useFakeTimers();
    const record = vi.fn();
    render(
      <SeenContext.Provider value={record}>
        <div hidden={hidden}>
          <BriefingView briefing={b} />
        </div>
      </SeenContext.Provider>,
    );
    return record;
  };

  it("counts a step's place once it has been shown for 1.5 s, and not a step you passed quickly", () => {
    const record = seenIn(briefing);
    key("g");
    act(() => vi.advanceTimersByTime(1_000));
    key("n");
    act(() => vi.advanceTimersByTime(1_499));
    expect(record).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(record.mock.calls).toEqual([
      ["acme/api#1", "old0000", { checkId: "callers.outside", path: "src/api.ts", line: 9, how: "guided" }],
    ]);
    // The model's extra step, left before it counts.
    key("n");
    act(() => vi.advanceTimersByTime(500));
    key("Escape");
    act(() => vi.advanceTimersByTime(5_000));
    expect(record).toHaveBeenCalledTimes(1);
    // Back on it for long enough: the model's places have no check.
    key("g");
    act(() => vi.advanceTimersByTime(1_500));
    expect(record).toHaveBeenLastCalledWith("acme/api#1", "old0000", { path: "src/web.ts", line: 1, how: "guided" });
  });

  it("counts nothing for your local changes, a briefing without its head commit, or a step you can't see", () => {
    const local = seenIn({ ...briefing, target: { kind: "local", repoRoot: "/r", branch: "main" } });
    key("g");
    act(() => vi.advanceTimersByTime(5_000));
    expect(local).not.toHaveBeenCalled();
    cleanup();
    forgetProgress();

    const { headSha: _, ...noHead } = briefing.target as Extract<Briefing["target"], { kind: "pr" }>;
    const old = seenIn({ ...briefing, target: noHead });
    key("g");
    act(() => vi.advanceTimersByTime(5_000));
    expect(old).not.toHaveBeenCalled();
    cleanup();
    forgetProgress();

    const hidden = seenIn(briefing, true);
    key("g");
    act(() => vi.advanceTimersByTime(5_000));
    expect(hidden).not.toHaveBeenCalled();
  });
});
