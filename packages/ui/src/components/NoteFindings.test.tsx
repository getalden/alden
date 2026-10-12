// @vitest-environment jsdom
import type { Briefing, FeedbackItem, MemoryItem } from "@alden/schema";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Session } from "../api";
import { type BriefingFeedback, noteArea, type Verdict } from "../feedback";
import { forgetProgress } from "../guided";
import { BriefingView, findingItem } from "./BriefingView";
import { MemoryView } from "./MemoryView";

afterEach(() => {
  cleanup();
  forgetProgress();
});

const owners = { id: "note:owners", text: "Every file needs a code owner header" };

const briefing: Briefing = {
  schemaVersion: 1,
  target: {
    kind: "pr",
    repo: "acme/api",
    number: 1,
    url: "https://github.com/acme/api/pull/1",
    title: "Add the users route",
    author: "sam",
    baseRef: "main",
    headRef: "feature",
  },
  generatedAt: "2026-10-07T10:00:00Z",
  summary: { files: 1, additions: 3, deletions: 0, reviewableAdditions: 3, reviewableDeletions: 0 },
  files: [
    {
      path: "app/api/users/route.ts",
      status: "added",
      kind: "code",
      additions: 3,
      deletions: 0,
      binary: false,
      patchMissing: false,
    },
  ],
  checks: [],
  needsYourEyes: [
    {
      title: "Charge in floats",
      reason: "Uses a float for money.",
      anchor: { path: "app/api/users/route.ts", line: 2 },
      source: "llm",
    },
  ],
  notChecked: [],
  llm: {
    status: "ok",
    findings: [
      {
        title: "Charge in floats",
        detail: "Uses a float for money.",
        severity: "medium",
        anchors: [{ path: "app/api/users/route.ts", line: 2 }],
      },
      {
        title: "Missing code owner header",
        detail: "The new file has no owner header.",
        severity: "low",
        anchors: [{ path: "app/api/users/route.ts" }],
        fromNote: owners,
      },
    ],
    droppedFindings: 0,
    omittedFiles: [],
  },
};

function fakeFeedback() {
  const verdicts = new Map<string, Verdict>();
  const items: FeedbackItem[] = [];
  const changes: unknown[] = [];
  const feedback: BriefingFeedback = {
    verdictOf: (item) => verdicts.get(item.title),
    progressOf: () => undefined,
    toggle(item, verdict) {
      items.push(item);
      verdicts.set(item.title, verdict);
    },
    reportMissed: async () => {},
    missedCount: 0,
    error: undefined,
    changeNote: async (change) => {
      changes.push(change);
    },
  };
  return { feedback, items, changes };
}

describe("a model finding from one of your notes", () => {
  it("records reactions against the note, not a check", () => {
    expect(findingItem(briefing.llm?.findings[1] as never)).toEqual({
      source: "llm",
      title: "Missing code owner header",
      severity: "low",
      anchor: { path: "app/api/users/route.ts" },
      placement: "finding",
      note: "note:owners",
    });
    expect(noteArea("app/api/users/route.ts")).toBe("app/api");
    expect(noteArea("lib/x.ts")).toBe("lib");
    expect(noteArea("README.md")).toBe("README.md");
  });

  it("says it's because of your note, and after Not useful offers to stop the note there", async () => {
    const { feedback, items, changes } = fakeFeedback();
    const { rerender } = render(<BriefingView briefing={briefing} feedback={feedback} />);
    fireEvent.click(screen.getByRole("button", { name: /^The model also noticed/ }));
    const finding = screen.getByText("Missing code owner header.").closest("li") as HTMLElement;
    expect(within(finding).getByText("Because of your note: Every file needs a code owner header")).toBeTruthy();
    // Only the finding from the note says so.
    expect(document.querySelectorAll(".from-note")).toHaveLength(1);
    expect(within(finding).queryByText(/Stop applying this note/)).toBeNull();

    fireEvent.click(within(finding).getByRole("button", { name: "Not useful" }));
    rerender(<BriefingView briefing={briefing} feedback={feedback} />);
    expect(items.at(-1)).toMatchObject({ note: "note:owners", placement: "finding" });
    expect(within(finding).getByText("Stop applying this note to app/api?")).toBeTruthy();

    fireEvent.click(within(finding).getByRole("button", { name: "Stop applying" }));
    expect(await within(finding).findByText("This note no longer applies under app/api.")).toBeTruthy();
    fireEvent.click(within(finding).getByRole("button", { name: "Undo" }));
    expect(await within(finding).findByText("Stop applying this note to app/api?")).toBeTruthy();

    fireEvent.click(within(finding).getByRole("button", { name: "Edit the note" }));
    fireEvent.change(within(finding).getByLabelText("Edit your note"), {
      target: { value: "Every source file needs a code owner header" },
    });
    fireEvent.click(within(finding).getByRole("button", { name: "Save" }));
    expect(await within(finding).findByText("Note updated. Reviews from now on use the new text.")).toBeTruthy();
    expect(changes).toEqual([
      { action: "exclude", id: "note:owners", path: "app/api" },
      { action: "include", id: "note:owners", path: "app/api" },
      { action: "edit", id: "note:owners", text: "Every source file needs a code owner header" },
    ]);
  });

  it("offers nothing on Useful, or without a repo to change the note in", () => {
    const { feedback } = fakeFeedback();
    const { rerender } = render(<BriefingView briefing={briefing} feedback={feedback} />);
    fireEvent.click(screen.getByRole("button", { name: /^The model also noticed/ }));
    const finding = screen.getByText("Missing code owner header.").closest("li") as HTMLElement;
    fireEvent.click(within(finding).getByRole("button", { name: "Useful" }));
    rerender(<BriefingView briefing={briefing} feedback={feedback} />);
    expect(within(finding).queryByText(/Stop applying/)).toBeNull();

    const { changeNote: _, ...noRepo } = feedback;
    fireEvent.click(within(finding).getByRole("button", { name: "Not useful" }));
    rerender(<BriefingView briefing={briefing} feedback={noRepo} />);
    expect(within(finding).queryByText(/Stop applying/)).toBeNull();
  });

  it("says so in guided review's extra steps, with the same offer", async () => {
    const { feedback, changes } = fakeFeedback();
    const { rerender } = render(<BriefingView briefing={briefing} feedback={feedback} />);
    fireEvent.click(screen.getByRole("button", { name: /^Walk through th/ }));
    fireEvent.click(screen.getByRole("button", { name: /Next: 1 more from the model/ }));
    const guided = screen.getByRole("region", { name: "Missing code owner header" });
    expect(within(guided).getByText("Because of your note: Every file needs a code owner header")).toBeTruthy();
    fireEvent.click(within(guided).getByRole("button", { name: "Not useful" }));
    rerender(<BriefingView briefing={briefing} feedback={feedback} />);
    const again = screen.getByRole("region", { name: "Missing code owner header" });
    fireEvent.click(within(again).getByRole("button", { name: "Stop applying" }));
    await waitFor(() => expect(changes).toEqual([{ action: "exclude", id: "note:owners", path: "app/api" }]));
  });
});

describe("the Memory view and a note's reactions", () => {
  it("shows how often a note was confirmed and applies it under a folder again", async () => {
    let item: MemoryItem = {
      id: "note:owners",
      repo: "acme/api",
      source: "you",
      kind: "note",
      group: "look",
      text: "Every file needs a code owner header",
      effect: "Given to the model with every review of this repo, except under app/api.",
      confirmed: 3,
      excluded: ["app/api"],
      since: "2026-09-20T10:00:00Z",
    };
    const calls: unknown[] = [];
    const memory = () => ({ repo: "acme/api", items: [item], paused: false, path: "/x" });
    const api = {
      memoryRepos: async () => [{ repo: "acme/api", items: 1, lastChange: new Date().toISOString(), paused: false }],
      memory: async () => memory(),
      changeMemory: async (change: unknown) => {
        calls.push(change);
        const { excluded: _, ...rest } = item;
        item = { ...rest, effect: "Given to the model with every review of this repo." };
        return memory();
      },
    } as unknown as import("../api").Api;
    render(<MemoryView api={api} session={{ repo: { root: "/r", repos: ["acme/api"] } } as unknown as Session} />);
    expect(await screen.findByText("· confirmed 3×")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply this note under app/api again" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /under app\/api again/ })).toBeNull());
    expect(calls).toEqual([{ action: "include", id: "note:owners", path: "app/api" }]);
  });
});
