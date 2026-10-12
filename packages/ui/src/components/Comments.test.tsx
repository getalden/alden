// @vitest-environment jsdom
import type { Briefing, PrDiff } from "@alden/schema";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Api, ApiError, type ReviewRequest } from "../api";
import {
  cannotSend,
  type DraftPatch,
  groupDrafts,
  linkedText,
  type NewDraft,
  type ReviewDraft,
  type ReviewEvent,
  reviewBody,
  type SendReviewResult,
  type Unaddressed,
  useDrafts,
  whereText,
} from "../drafts";
import { BriefingView } from "./BriefingView";
import { goesInBody, linkedNotice, parseLines, useReviewActions } from "./Comments";
import { QueueView } from "./QueueView";
import { ReviewPane } from "./ReviewPane";

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

const PR = "acme/api#1";

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
  },
  generatedAt: "2026-09-30T10:00:00Z",
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
      path: "src/old.ts",
      status: "removed",
      kind: "code",
      additions: 0,
      deletions: 1,
      binary: false,
      patchMissing: false,
    },
  ],
  checks: [
    {
      id: "callers.outside",
      title: "Callers outside the diff",
      status: "flagged",
      severity: "high",
      summary: "1 caller.",
      evidence: [
        { text: "calls charge (signature changed)", anchor: { path: "src/api.ts", line: 9 } },
        { text: "the whole file", anchor: { path: "src/web.ts" } },
      ],
      heuristic: false,
    },
  ],
  needsYourEyes: [
    {
      title: "Caller of changed code in src/api.ts",
      reason: "calls charge (signature changed).",
      anchor: { path: "src/api.ts", line: 9 },
      checkId: "callers.outside",
    },
    { title: "No tests", reason: "nothing tests it." },
  ],
  notChecked: [],
};

const draft = (id: string, extra: Partial<ReviewDraft> = {}): ReviewDraft => ({
  id,
  pr: PR,
  headSha: "abc",
  body: `Body ${id}`,
  source: "you",
  createdAt: `2026-10-01T10:00:0${id.length}Z`,
  updatedAt: "2026-10-01T10:00:00Z",
  state: "draft",
  ...extra,
});

/** The local API's drafts routes, in memory. */
function fakeApi(start: ReviewDraft[] = [], unaddressed: Unaddressed[] = []) {
  const state = {
    drafts: [...start],
    unaddressed,
    calls: [] as string[],
    sendError: undefined as string | undefined,
    /** What the engine says it learned from the review, when it learns from reviews. */
    learning: undefined as string[] | undefined,
    /** Paths the server would link to rather than comment on inline (a whole file always is). */
    outside: new Set<string>(),
  };
  let next = 0;
  const api = {
    drafts: async (pr: string) => {
      state.calls.push(`GET ${pr}`);
      return { drafts: [...state.drafts], unaddressed: state.unaddressed };
    },
    addDraft: async (input: NewDraft & { pr: string }) => {
      state.calls.push(`POST ${JSON.stringify(input)}`);
      const { path, line, startLine, side: _side, pr: _pr, ...rest } = input;
      const linked = path !== undefined && (line === undefined || state.outside.has(path));
      const saved = linked
        ? draft(`n${next++}`, {
            ...rest,
            linkTo: {
              path,
              ...(line !== undefined ? { line } : {}),
              ...(startLine !== undefined ? { startLine } : {}),
            },
          })
        : draft(`n${next++}`, { ...input, body: input.body });
      state.drafts.push(saved);
      return saved;
    },
    editDraft: async (id: string, patch: DraftPatch) => {
      state.calls.push(`PATCH ${id} ${JSON.stringify(patch)}`);
      state.drafts = state.drafts.map((d) => {
        if (d.id !== id) return d;
        const { suggestion, ...rest } = { ...d, ...patch };
        return suggestion === null || suggestion === undefined ? rest : { ...rest, suggestion };
      });
      return state.drafts.find((d) => d.id === id) as ReviewDraft;
    },
    deleteDraft: async (id: string) => {
      state.calls.push(`DELETE ${id}`);
      state.drafts = state.drafts.filter((d) => d.id !== id);
      return { ok: true as const };
    },
    keepDrafts: async (which: { ids: string[] } | { pr: string }) => {
      state.calls.push(`KEEP ${JSON.stringify(which)}`);
      const kept: ReviewDraft[] = [];
      state.drafts = state.drafts.map((d) => {
        if (d.source !== "alden" || ("ids" in which && !which.ids.includes(d.id))) return d;
        const mine = { ...d, source: "you" as const };
        kept.push(mine);
        return mine;
      });
      return { kept };
    },
    sendReview: async (review: { pr: string; event: ReviewEvent; body?: string }): Promise<SendReviewResult> => {
      state.calls.push(`SEND ${JSON.stringify(review)}`);
      if (state.sendError) throw new ApiError(422, state.sendError);
      // Like the server: Alden's drafts you didn't keep don't post.
      const posted = state.drafts.filter((d) => d.path && d.source !== "alden").length;
      state.drafts = [];
      return {
        url: "https://github.com/acme/api/pull/1#pullrequestreview-9",
        posted,
        review: review.event,
        ...(state.learning ? { learning: state.learning } : {}),
      };
    },
  } as unknown as Api;
  return { api, state };
}

/** The PR pane as App shows it: the briefing, and the Comments drawer beside it. */
function Harness({
  api,
  b = briefing,
  loadDiff,
  children,
}: {
  api: Api;
  b?: Briefing;
  loadDiff?: (pr?: string) => Promise<PrDiff>;
  children?: ReactNode;
}) {
  const comments = useDrafts(api, PR);
  const request = { pr: PR } as ReviewRequest;
  return (
    <ReviewPane
      crumbs={null}
      title="Change the charge API"
      run={{ stages: [], running: false, startedAt: 0, briefing: b, request }}
      controls={null}
      onStart={() => {}}
      onCancel={() => {}}
      request={request}
      emptyHint=""
      comments={comments}
      loadDiff={loadDiff}
    >
      {children}
    </ReviewPane>
  );
}

const drawer = () => screen.queryByRole("complementary", { name: "Comments" });
const toggle = () => screen.getByRole("button", { name: /^Comments/ });

async function setup(start: ReviewDraft[] = [], unaddressed: Unaddressed[] = [], open = true, children?: ReactNode) {
  const fake = fakeApi(start, unaddressed);
  const view = render(<Harness api={fake.api}>{children}</Harness>);
  await waitFor(() => expect(fake.state.calls).toContain(`GET ${PR}`));
  if (start.length > 0) await waitFor(() => expect(toggle().textContent).toContain(`· ${start.length}`));
  if (open) fireEvent.click(toggle());
  return { ...fake, view };
}

/** Stands in for the diff and the guided review: they call the review's actions from inside the pane. */
function Probe({ place }: { place: Parameters<NonNullable<ReturnType<typeof useReviewActions>>["onComment"]>[0] }) {
  const actions = useReviewActions();
  return (
    <>
      <button type="button" onClick={() => actions?.onComment(place)}>
        Diff line
      </button>
      <button type="button" onClick={() => actions?.onFinish()}>
        Finish
      </button>
    </>
  );
}

const key = (k: string, target: EventTarget = document.body, extra: KeyboardEventInit = {}) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));
  });

describe("the Comments drawer", () => {
  it("opens and closes from the toolbar, s and Esc, says where drafts go, and is remembered for the window", async () => {
    await setup([], [], false);
    // jsdom's window is 1024px wide: too narrow to start open.
    expect(drawer()).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle());
    const aside = drawer() as HTMLElement;
    expect(document.activeElement).toBe(within(aside).getByRole("heading", { name: "Comments" }));
    expect(aside.textContent).toContain("Kept on this machine until you send them to acme/api#1 on GitHub");
    expect(within(aside).getByText(/No comments yet/)).toBeTruthy();
    expect(window.sessionStorage.getItem("alden.comments.drawer")).toBe("1");

    // Esc inside it closes it and puts focus back on the toggle.
    key("Escape", document.activeElement as HTMLElement);
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(toggle());
    key("s");
    expect(drawer()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close comments" }));
    expect(drawer()).toBeNull();
    expect(window.sessionStorage.getItem("alden.comments.drawer")).toBe("0");

    // Another pane in this window starts as you left it.
    window.sessionStorage.setItem("alden.comments.drawer", "1");
    cleanup();
    render(<Harness api={fakeApi().api} />);
    expect(drawer()).not.toBeNull();
  });

  it("groups drafts by where they post, with the count on the toggle", async () => {
    await setup([
      draft("a", { path: "src/old.ts", line: 4, side: "LEFT", body: "Gone?" }),
      draft("bb", { path: "src/charge.ts", line: 9, startLine: 4, side: "RIGHT", source: "claude", body: "Rounding?" }),
      draft("ccc", { body: "Thanks!" }),
    ]);
    expect(toggle().textContent).toBe("Comments · 3 S");
    const aside = drawer() as HTMLElement;
    const lines = within(aside).getByRole("region", { name: "On lines · 2" });
    // In the briefing's file order, each saying where it posts.
    expect(
      within(lines)
        .getAllByRole("listitem")
        .map((li) => li.querySelector(".draft-where")?.textContent),
    ).toEqual(["On src/charge.ts, lines 4–9", "On src/old.ts, line 4 (old side)"]);
    expect(within(lines).getByText("from Claude")).toBeTruthy();
    const body = within(aside).getByRole("region", { name: "In the review body · 1" });
    expect(within(body).getByText("In the review body")).toBeTruthy();
    expect(within(body).getByText("Thanks!")).toBeTruthy();
    expect(within(aside).getByRole("button", { name: "Send review · 3 comments" })).toBeTruthy();
  });
});

describe("commenting on a place", () => {
  it("opens the drawer's editor on a place in Needs your eyes, saves with Ctrl+Enter, and gives focus back", async () => {
    const { state } = await setup([], [], false);
    // The place in Needs your eyes and the check's evidence line; the whole-file evidence has its own.
    const buttons = screen.getAllByRole("button", { name: "Comment on src/api.ts, line 9" });
    expect(buttons).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Comment on src/web.ts" })).toBeTruthy();
    fireEvent.click(buttons[0] as HTMLElement);
    const aside = drawer() as HTMLElement;
    expect(within(aside).getByRole("heading", { name: "Comment on src/api.ts, line 9" })).toBeTruthy();
    const area = within(aside).getByRole("textbox", { name: "Comment on src/api.ts, line 9" });
    expect(document.activeElement).toBe(area);
    fireEvent.change(area, { target: { value: "Does the web client pass a currency?" } });
    fireEvent.keyDown(area, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(state.calls).toContain(
        `POST ${JSON.stringify({ pr: PR, path: "src/api.ts", line: 9, side: "RIGHT", body: "Does the web client pass a currency?" })}`,
      ),
    );
    await waitFor(() => expect(within(aside).queryByRole("textbox", { name: /^Comment on/ })).toBeNull());
    expect(document.activeElement).toBe(buttons[0]);
    // It shows at the place and in the drawer, saying where it posts.
    expect(screen.getAllByRole("list", { name: "Your comments on src/api.ts, line 9" })).toHaveLength(2);
    const lines = within(aside).getByRole("region", { name: "On lines · 1" });
    expect(within(lines).getByText("Does the web client pass a currency?")).toBeTruthy();
    expect(lines.querySelector(".draft-where")?.textContent).toBe("On src/api.ts, line 9");
    expect(toggle().textContent).toBe("Comments · 1 S");
    expect(screen.getByRole("button", { name: "Send review · 1 comment" })).toBeTruthy();
  });

  it("cancels with Escape and keeps nothing, leaving the drawer open", async () => {
    const { state } = await setup();
    const button = screen.getAllByRole("button", { name: "Comment on src/api.ts, line 9" })[1] as HTMLElement;
    fireEvent.click(button);
    const area = screen.getByRole("textbox", { name: "Comment on src/api.ts, line 9" });
    fireEvent.change(area, { target: { value: "never mind" } });
    fireEvent.keyDown(area, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Comment on src/api.ts, line 9" })).toBeNull();
    expect(drawer()).not.toBeNull();
    expect(document.activeElement).toBe(button);
    expect(state.calls.some((c) => c.startsWith("POST"))).toBe(false);
  });

  it("keeps the text and says why when saving fails", async () => {
    const { api } = fakeApi();
    (api as unknown as { addDraft: () => Promise<never> }).addDraft = async () => {
      throw new ApiError(400, "That line isn't in the diff.");
    };
    render(<Harness api={api} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Comment on src/api.ts, line 9" })[0] as HTMLElement);
    const area = screen.getByRole("textbox", { name: "Comment on src/api.ts, line 9" });
    fireEvent.change(area, { target: { value: "Keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That line isn't in the diff.");
    expect((area as HTMLTextAreaElement).value).toBe("Keep me");
  });
});

describe("onComment and onFinish, for the diff and the guided review", () => {
  it("comments on a range with a suggested change started from the lines' text, then edits and drops it", async () => {
    const { state } = await setup(
      [],
      [],
      false,
      <Probe place={{ path: "src/charge.ts", line: 9, startLine: 4, side: "RIGHT", lineText: "a = 1\nb = 2" }} />,
    );
    const diffLine = screen.getByRole("button", { name: "Diff line" });
    diffLine.focus();
    fireEvent.click(diffLine);
    const aside = drawer() as HTMLElement;
    expect(within(aside).getByRole("heading", { name: "Comment on src/charge.ts, lines 4–9" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Comment on src/charge.ts, lines 4–9" }));
    const suggest = within(aside).getByRole("button", { name: "± Suggest a change" });
    expect(suggest.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(suggest);
    const code = screen.getByRole("textbox", { name: "Suggested change for lines 4–9" }) as HTMLTextAreaElement;
    expect(code.value).toBe("a = 1\nb = 2");
    expect(document.activeElement).toBe(code);
    expect(aside.textContent).toContain("Replaces lines 4–9 when the author accepts it on GitHub.");
    fireEvent.change(code, { target: { value: "a = 1\nb = 3" } });
    // A suggestion needs no text of its own; ⌘↵ saves from the code too.
    fireEvent.keyDown(code, { key: "Enter", metaKey: true });
    await waitFor(() =>
      expect(state.calls).toContain(
        `POST ${JSON.stringify({ pr: PR, path: "src/charge.ts", line: 9, startLine: 4, side: "RIGHT", body: "", suggestion: "a = 1\nb = 3" })}`,
      ),
    );
    await waitFor(() => expect(document.activeElement).toBe(diffLine));
    const lines = within(aside).getByRole("region", { name: "On lines · 1" });
    expect(lines.querySelector(".draft-where")?.textContent).toBe("On src/charge.ts, lines 4–9");
    expect(within(lines).getByText("Suggested change")).toBeTruthy();
    expect(lines.querySelector("pre")?.textContent).toBe("a = 1\nb = 3");

    // Edit: add words, then take the suggestion off.
    fireEvent.click(within(lines).getByRole("button", { name: "Edit comment on src/charge.ts, lines 4–9" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit comment on src/charge.ts, lines 4–9" }), {
      target: { value: "Should b change?" },
    });
    fireEvent.click(within(lines).getByRole("button", { name: "± Suggest a change" }));
    fireEvent.click(within(lines).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(state.calls).toContain(`PATCH n0 {"body":"Should b change?","suggestion":null}`));
    await waitFor(() => expect(lines.querySelector("pre")).toBeNull());
  });

  it("offers no suggestion on the old side, and onFinish opens the drawer at the review body", async () => {
    await setup([], [], false, <Probe place={{ path: "src/old.ts", line: 2, side: "LEFT" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Diff line" }));
    expect(screen.getByRole("textbox", { name: "Comment on src/old.ts, line 2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "± Suggest a change" })).toBeNull();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close comments" }));
    expect(drawer()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(drawer()).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Review body" }));
  });
});

describe("notes linking to code outside the diff", () => {
  const diff: PrDiff = {
    headSha: "abc",
    files: [
      {
        path: "src/charge.ts",
        status: "modified",
        hunks: [
          {
            header: "@@ -1,2 +1,2 @@",
            lines: [
              { kind: "del", oldLine: 1, text: "charge(a)" },
              { kind: "add", newLine: 1, text: "charge(a, b)" },
            ],
          },
        ],
      },
    ],
  };

  it("comments on a whole file as a note in the review body, linking to it", async () => {
    const { state } = await setup([], [], false);
    fireEvent.click(screen.getByRole("button", { name: "Comment on src/web.ts" }));
    const aside = drawer() as HTMLElement;
    expect(within(aside).getByRole("heading", { name: "Comment on src/web.ts, the whole file" })).toBeTruthy();
    expect(within(aside).getByRole("note").textContent).toBe(
      "A comment on a whole file goes in the review body, with a link to the file.",
    );
    expect(within(aside).queryByRole("button", { name: /Suggest a change/ })).toBeNull();
    const area = within(aside).getByRole("textbox", { name: "Comment on src/web.ts" });
    fireEvent.change(area, { target: { value: "Does this still call charge?" } });
    fireEvent.keyDown(area, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(state.calls).toContain(
        `POST ${JSON.stringify({ pr: PR, path: "src/web.ts", side: "RIGHT", body: "Does this still call charge?" })}`,
      ),
    );
    const body = await within(aside).findByRole("region", { name: "In the review body · 1" });
    const where = body.querySelector(".draft-where") as HTMLElement;
    expect(where.textContent).toBe("In the review body · links to src/web.ts");
    expect(where.querySelector("[title]")?.getAttribute("title")).toMatch(/code at abc, the PR's head when this was/);
    // It shows at the place in the briefing too.
    expect(screen.getByRole("list", { name: "Your comments on src/web.ts" }).textContent).toContain("Does this still");
  });

  it("says before saving when a line isn't in the diff, keeps a suggestion as code, and shows the link in the body", async () => {
    const fake = fakeApi();
    fake.state.outside.add("src/api.ts");
    render(<Harness api={fake.api} loadDiff={async () => diff} />);
    await waitFor(() => expect(fake.state.calls).toContain(`GET ${PR}`));
    fireEvent.click(screen.getAllByRole("button", { name: "Comment on src/api.ts, line 9" })[0] as HTMLElement);
    const aside = drawer() as HTMLElement;
    expect((await within(aside).findByRole("note")).textContent).toBe(
      "This line isn't in the PR's diff, so it goes in the review body with a link to it.",
    );
    fireEvent.click(within(aside).getByRole("button", { name: /Suggest a change/ }));
    expect(aside.textContent).toContain("In the review body GitHub can't apply it, so it posts as code");
    fireEvent.change(within(aside).getByRole("textbox", { name: "Suggested change for line 9" }), {
      target: { value: "charge(a, b)" },
    });
    fireEvent.click(within(aside).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(aside).queryByRole("textbox", { name: /^Comment on/ })).toBeNull());
    const body = within(aside).getByRole("region", { name: "In the review body · 1" });
    expect(body.querySelector(".draft-where")?.textContent).toBe("In the review body · links to src/api.ts, line 9");
    expect(within(body).getByText("charge(a, b)")).toBeTruthy();

    // What posts: the note in the body, starting with its link.
    fireEvent.click(within(aside).getByRole("button", { name: "Send review · 1 comment" }));
    const confirm = await within(aside).findByRole("region", { name: /Send this review/ });
    expect(confirm.textContent).toContain(
      "**[`src/api.ts` line 9](https://github.com/acme/api/blob/abc/src/api.ts#L9)**\n\nSuggested change:\n\n```\ncharge(a, b)\n```",
    );

    // A line in the diff says nothing extra.
    fireEvent.click(within(confirm).getByRole("button", { name: "Back" }));
    fireEvent.click(within(aside).getByRole("button", { name: "Comment on a line…" }));
    expect(within(aside).queryByRole("note")).toBeNull();
    fireEvent.change(within(aside).getByRole("textbox", { name: "Line" }), { target: { value: "40" } });
    expect(within(aside).getByRole("note").textContent).toMatch(/^This line isn't in the PR's diff/);
    fireEvent.change(within(aside).getByRole("textbox", { name: "Line" }), { target: { value: "1" } });
    expect(within(aside).queryByRole("note")).toBeNull();
  });

  it("offers Comment on what the model also noticed", async () => {
    const fake = fakeApi();
    const withFindings: Briefing = {
      ...briefing,
      llm: {
        status: "ok",
        findings: [
          {
            title: "Retry loops",
            detail: "It never stops.",
            severity: "medium",
            anchors: [{ path: "py/orders/tasks.py", line: 5 }],
          },
        ],
        droppedFindings: 0,
        omittedFiles: [],
      },
    };
    render(<Harness api={fake.api} b={withFindings} />);
    await waitFor(() => expect(fake.state.calls).toContain(`GET ${PR}`));
    const noticed = screen.getByRole("region", { name: "The model also noticed · 1" });
    fireEvent.click(within(noticed).getByRole("button", { name: "Comment on py/orders/tasks.py, line 5" }));
    expect(
      within(drawer() as HTMLElement).getByRole("heading", { name: "Comment on py/orders/tasks.py, line 5" }),
    ).toBeTruthy();
  });

  it('says "Draft ready" on a finding Alden drafted a comment for, until you keep or drop it', async () => {
    const fake = fakeApi([
      draft("a", {
        path: "py/orders/tasks.py",
        line: 5,
        side: "RIGHT",
        source: "alden",
        drafted: { checkId: "model", title: "Retry loops" },
        body: "Stop retrying after five tries.",
      }),
    ]);
    const finding = {
      title: "Retry loops",
      detail: "It never stops.",
      severity: "medium" as const,
      anchors: [{ path: "py/orders/tasks.py", line: 5 }],
      draft: { body: "Stop retrying after five tries." },
    };
    const withDraft: Briefing = {
      ...briefing,
      llm: { status: "ok", findings: [finding], droppedFindings: 0, omittedFiles: [] },
    };
    render(<Harness api={fake.api} b={withDraft} />);
    const noticed = screen.getByRole("region", { name: "The model also noticed · 1" });
    await waitFor(() => expect(within(noticed).getByText("Draft ready")).toBeTruthy());
  });
});

describe("comment keys", () => {
  it("c comments on the place you're on, or opens Comment on a line; s toggles the drawer; typing never triggers them", async () => {
    await setup([], [], false);
    // On a place: c opens its editor in the drawer.
    const button = screen.getAllByRole("button", { name: "Comment on src/api.ts, line 9" })[0] as HTMLElement;
    button.focus();
    key("c", button);
    const area = screen.getByRole("textbox", { name: "Comment on src/api.ts, line 9" });
    expect(document.activeElement).toBe(area);
    // In a textarea, c and s are just letters.
    key("c", area);
    key("s", area);
    expect(document.activeElement).toBe(area);
    expect(drawer()).not.toBeNull();
    expect(screen.queryByRole("combobox", { name: "File" })).toBeNull();
    fireEvent.keyDown(area, { key: "Escape" });
    expect(document.activeElement).toBe(button);

    // Nowhere in particular: c opens Comment on a line, with the file picker focused.
    button.blur();
    key("c");
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "File" }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Comment on a line…" }));

    // s closes it (focus was in it, so it goes to the toggle), and opens it again.
    (document.activeElement as HTMLElement).blur();
    key("s");
    expect(drawer()).toBeNull();
    key("s");
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Comments" }));
    // With a modifier, the browser's own shortcut wins.
    key("s", document.body, { metaKey: true });
    expect(drawer()).not.toBeNull();
  });
});

describe("Comment on a line and general notes", () => {
  it("comments on any line or range of a changed file, the old side for a removed file, and adds a general note", async () => {
    const { state } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Comment on a line…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Why 3?" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Give a line number, or a range like 4–9.");
    fireEvent.change(screen.getByRole("textbox", { name: "Line" }), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(state.calls).toContain(
        `POST ${JSON.stringify({ pr: PR, path: "src/charge.ts", line: 12, side: "RIGHT", body: "Why 3?" })}`,
      ),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Comment on a line…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Line" }), { target: { value: "4-6" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "All three?" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(state.calls).toContain(
        `POST ${JSON.stringify({ pr: PR, path: "src/charge.ts", line: 6, startLine: 4, side: "RIGHT", body: "All three?" })}`,
      ),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Comment on a line…" }));
    fireEvent.change(screen.getByRole("combobox", { name: "File" }), { target: { value: "src/old.ts" } });
    expect(screen.queryByRole("button", { name: "± Suggest a change" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Line" }), { target: { value: "4" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Still used?" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(state.calls).toContain(
        `POST ${JSON.stringify({ pr: PR, path: "src/old.ts", line: 4, side: "LEFT", body: "Still used?" })}`,
      ),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add a general note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "General note" }), { target: { value: "Nice cleanup." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(state.calls).toContain(`POST ${JSON.stringify({ pr: PR, body: "Nice cleanup." })}`));
    await waitFor(() =>
      expect(
        within(drawer() as HTMLElement)
          .getAllByRole("heading", { level: 3 })
          .map((h) => h.textContent),
      ).toEqual(["On lines · 3", "In the review body · 1"]),
    );
  });
});

describe("sending from the drawer", () => {
  it("labels Claude's drafts, edits and deletes, and makes you rewrite an outdated one before sending", async () => {
    const { state } = await setup([
      draft("a", { path: "src/charge.ts", line: 3, side: "RIGHT", source: "claude", body: "Rounding?" }),
      draft("bb", { path: "src/charge.ts", line: 1, side: "RIGHT", state: "outdated", body: "Old line" }),
      draft("ccc", { body: "General" }),
    ]);
    expect(screen.getByText("from Claude")).toBeTruthy();
    expect(screen.getByText("Outdated")).toBeTruthy();
    expect(screen.getByText(/The PR has new commits since this was written/)).toBeTruthy();
    const send = screen.getByRole("button", { name: "Send review · 3 comments" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(screen.getByText("Rewrite or delete the outdated comment first.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit comment on src/charge.ts, line 3" }));
    const edit = screen.getByRole("textbox", { name: "Edit comment on src/charge.ts, line 3" });
    fireEvent.change(edit, { target: { value: "Rounding? Use cents." } });
    fireEvent.keyDown(edit, { key: "Enter", metaKey: true });
    await waitFor(() => expect(state.calls).toContain(`PATCH a {"body":"Rounding? Use cents."}`));
    await screen.findByText("Rounding? Use cents.");

    fireEvent.click(screen.getByRole("button", { name: "Rewrite comment on src/charge.ts, line 1" }));
    expect(screen.getByRole("heading", { name: "Rewrite on the current code" })).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "File" }) as HTMLSelectElement).value).toBe("src/charge.ts");
    expect((screen.getByRole("textbox", { name: "Line" }) as HTMLInputElement).value).toBe("1");
    fireEvent.change(screen.getByRole("textbox", { name: "Line" }), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(state.calls).toContain("DELETE bb"));
    expect(state.calls).toContain(
      `POST ${JSON.stringify({ pr: PR, path: "src/charge.ts", line: 2, side: "RIGHT", body: "Old line" })}`,
    );
    await waitFor(() => expect(screen.queryByText("Outdated")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Delete general note" }));
    expect(screen.getByText("Delete this note?")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(state.calls).toContain("DELETE ccc"));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Send review · 2 comments" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Comments" }));
  });

  it("labels Alden's drafts with Keep, Edit and Drop, and sends only the ones you kept", async () => {
    const drafted = { checkId: "model", title: "Rounding" };
    const { state } = await setup([
      draft("a", { path: "src/charge.ts", line: 3, side: "RIGHT", source: "alden", drafted, body: "Round to cents." }),
      draft("bb", { path: "src/charge.ts", line: 9, side: "RIGHT", source: "alden", drafted, body: "Check the cap." }),
      draft("ccc", { path: "src/charge.ts", line: 20, side: "RIGHT", source: "alden", drafted, body: "Log less." }),
      draft("dddd", { body: "Thanks!" }),
    ]);
    expect(screen.getAllByText("Drafted by Alden")).toHaveLength(3);
    const bar = screen.getByRole("region", { name: "Alden's drafts" });
    expect(bar.textContent).toContain("Alden drafted 3 comments");
    expect(bar.textContent).toContain("3 drafts by Alden not kept won't be sent.");
    // Untouched, they don't count toward what's sent.
    expect(screen.getByRole("button", { name: "Send review · 1 comment" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Keep comment on src/charge.ts, line 3" }));
    await waitFor(() => expect(state.calls).toContain(`KEEP ${JSON.stringify({ ids: ["a"] })}`));
    await waitFor(() => expect(screen.getAllByText("Drafted by Alden")).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Send review · 2 comments" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit comment on src/charge.ts, line 9" }));
    const edit = screen.getByRole("textbox", { name: "Edit comment on src/charge.ts, line 9" });
    fireEvent.change(edit, { target: { value: "Check the daily cap." } });
    fireEvent.keyDown(edit, { key: "Enter", metaKey: true });
    await waitFor(() => expect(state.calls).toContain(`PATCH bb {"body":"Check the daily cap."}`));

    fireEvent.click(screen.getByRole("button", { name: "Drop comment on src/charge.ts, line 20" }));
    await waitFor(() => expect(state.calls).toContain("DELETE ccc"));
    await waitFor(() => expect(screen.queryByText("Log less.")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /^Send review/ }));
    const summary = await screen.findByRole("region", { name: "Send this review to acme/api#1?" });
    expect(within(summary).getByText("Round to cents.")).toBeTruthy();
  });

  it("keeps or drops all of Alden's drafts at once", async () => {
    const drafted = { checkId: "model", title: "Rounding" };
    const { state } = await setup([
      draft("a", { path: "src/charge.ts", line: 3, side: "RIGHT", source: "alden", drafted, body: "Round to cents." }),
      draft("bb", { path: "src/charge.ts", line: 9, side: "RIGHT", source: "alden", drafted, body: "Check the cap." }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Keep all" }));
    await waitFor(() => expect(state.calls).toContain(`KEEP ${JSON.stringify({ pr: PR })}`));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Alden's drafts" })).toBeNull());
    expect(screen.getByRole("button", { name: "Send review · 2 comments" })).toBeTruthy();
  });

  it("drops all of Alden's drafts, leaving yours", async () => {
    const drafted = { checkId: "model", title: "Rounding" };
    const { state } = await setup([
      draft("a", { path: "src/charge.ts", line: 3, side: "RIGHT", source: "alden", drafted, body: "Round to cents." }),
      draft("bb", { body: "Thanks!" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Drop all" }));
    await waitFor(() => expect(state.calls).toContain("DELETE a"));
    expect(state.calls).not.toContain("DELETE bb");
    await waitFor(() => expect(screen.queryByText("Round to cents.")).toBeNull());
    expect(screen.getByText("Thanks!")).toBeTruthy();
  });

  it("shows exactly what will post, lists what you didn't comment on before Approve, then says it was sent", async () => {
    const { state } = await setup(
      [
        draft("a", { path: "src/charge.ts", line: 3, side: "RIGHT", source: "claude", body: "Rounding?" }),
        draft("bb", { body: "Thanks!" }),
      ],
      [{ checkId: "callers.outside", title: "Caller of changed code in src/api.ts", path: "src/api.ts", line: 9 }],
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Review body" }), { target: { value: "Looks right." } });
    const verdict = screen.getByRole("group", { name: "Verdict" });
    fireEvent.click(within(verdict).getByRole("button", { name: "Approve" }));
    expect(within(verdict).getByRole("button", { name: "Approve" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Send review · 2 comments" }));

    const summary = await screen.findByRole("region", { name: "Send this review to acme/api#1?" });
    // Focus moves to the summary's heading once it has rendered; on a busy machine that's a tick later.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(summary).getByRole("heading", { name: "Send this review to acme/api#1?" }),
      ),
    );
    // While it shows, the verdict and Send are its own.
    expect(screen.queryByRole("group", { name: "Verdict" })).toBeNull();
    expect(summary.textContent).toContain("Approve");
    expect(summary.textContent).toContain("Alden flagged 1 place you didn't comment on.");
    expect(within(summary).getByText("Caller of changed code in src/api.ts")).toBeTruthy();
    // The body is yours, then each general note.
    expect(within(summary).getByText("Looks right.\n\nThanks!", { normalizer: (s) => s })).toBeTruthy();
    expect(within(summary).getByText("src/charge.ts:3")).toBeTruthy();
    expect(within(summary).getByText("from Claude")).toBeTruthy();
    expect(within(summary).getByText("Rounding?")).toBeTruthy();
    // Nothing has been sent yet.
    expect(state.calls.some((c) => c.startsWith("SEND"))).toBe(false);

    // Esc goes back, keeping everything and the drawer open; then send for real.
    fireEvent.keyDown(within(summary).getByRole("button", { name: "Back" }), { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Send this review to acme/api#1?" })).toBeNull();
    expect(drawer()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send review · 2 comments" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve on GitHub" }));

    const sent = await within(drawer() as HTMLElement).findByRole("status");
    expect(sent.textContent).toContain("Sent to GitHub.");
    expect(sent.textContent).toContain("You approved with 1 comment.");
    expect(within(sent).getByRole("link", { name: "See the review ↗" }).getAttribute("href")).toBe(
      "https://github.com/acme/api/pull/1#pullrequestreview-9",
    );
    expect(state.calls).toContain(`SEND ${JSON.stringify({ pr: PR, event: "APPROVE", body: "Looks right." })}`);
    expect(state.calls.filter((c) => c.startsWith("SEND"))).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Send review" })).toBeTruthy();
    expect(toggle().textContent).toBe("Comments S");
    expect((screen.getByRole("textbox", { name: "Review body" }) as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByText(/^Alden learned/)).toBeNull();
  });

  it("says in one quiet line what Alden learned from the review it just sent", async () => {
    const { state } = await setup([draft("a", { path: "src/charge.ts", line: 3, side: "RIGHT" })]);
    state.learning = ["you care about callers flags (2 of 3)", "tests flags are worth less here"];
    fireEvent.click(screen.getByRole("button", { name: "Send review · 1 comment" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send to GitHub" }));
    await within(drawer() as HTMLElement).findByRole("status");
    expect(
      screen.getByText("Alden learned: you care about callers flags (2 of 3); tests flags are worth less here"),
    ).toBeTruthy();
  });

  it("shows the server's error and keeps the drafts when sending fails", async () => {
    const { state } = await setup([draft("a", { path: "src/charge.ts", line: 3, side: "RIGHT" })]);
    state.sendError = "Your sign-in can't write reviews. Sign in with GitHub again.";
    fireEvent.click(screen.getByRole("button", { name: "Send review · 1 comment" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send to GitHub" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Your sign-in can't write reviews. Sign in with GitHub again.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Send review · 1 comment" }));
    expect(screen.getByText("Body a")).toBeTruthy();
  });

  it("needs a body to request changes, and waits for the comment you're writing", async () => {
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    const send = screen.getByRole("button", { name: "Send review" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Review body" }), { target: { value: "Needs tests." } });
    expect(send.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Add a general note" }));
    expect(send.disabled).toBe(true);
    expect(screen.getByText("Save or cancel the comment you're writing first.")).toBeTruthy();
  });

  it("isn't offered for your local changes, or on another PR's briefing", async () => {
    const { api } = fakeApi();
    const local: Briefing = { ...briefing, target: { kind: "local", repoRoot: "/r", branch: "main" } };
    const request = {} as ReviewRequest;
    render(
      <ReviewPane
        crumbs={null}
        title="Your uncommitted changes"
        run={{ stages: [], running: false, startedAt: 0, briefing: local, request }}
        controls={null}
        onStart={() => {}}
        onCancel={() => {}}
        request={request}
        emptyHint=""
      />,
    );
    expect(screen.queryByRole("button", { name: /^Comments/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Comment on/ })).toBeNull();
    cleanup();
    function Other() {
      const comments = useDrafts(api, PR);
      const other = { ...briefing, target: { ...briefing.target, number: 2 } as Briefing["target"] };
      return <BriefingView briefing={other} comments={comments} onComment={() => {}} />;
    }
    render(<Other />);
    expect(screen.queryByRole("button", { name: /^Comment on/ })).toBeNull();
  });
});

describe("drafts on the queue", () => {
  it("flags a PR with drafts on its row", () => {
    const row = {
      pr: {
        repo: "acme/api",
        number: 1,
        title: "PR 1",
        url: "https://github.com/acme/api/pull/1",
        author: "sam",
        authorIsBot: false,
        isDraft: false,
        createdAt: "2026-09-28T10:00:00Z",
        updatedAt: "2026-09-28T10:00:00Z",
        baseRef: "main",
        headRef: "feature",
        additions: 1,
        deletions: 1,
        changedFiles: 1,
        files: [],
        filesTruncated: false,
        labels: [],
        ci: "success" as const,
        mergeable: "mergeable" as const,
        reviews: [],
        request: { direct: true, teams: [], requestedAt: null },
        codeownedFiles: [],
        stackedPrs: 0,
      },
      lane: "needs-you" as const,
      score: { risk: 1, wait: 1, blocking: 0, total: 2 },
      reasons: [],
      waitingHours: 3,
      waitingOnAuthor: false,
    };
    render(
      <QueueView
        queue={{
          schemaVersion: 1,
          viewer: "you",
          fetchedAt: new Date().toISOString(),
          needsYou: [row],
          fastTrack: [],
          warnings: [],
        }}
        error={undefined}
        loading={false}
        onRefresh={() => {}}
        selected={undefined}
        drafts={{ "acme/api#1": 2 }}
      />,
    );
    expect(screen.getByText("✎ 2").title).toBe("2 drafts");
  });
});

describe("drafts helpers", () => {
  it("groups by file in the briefing's order, puts notes first, and builds the body as it posts", () => {
    const drafts = [
      draft("a", { path: "z.ts", line: 5 }),
      draft("bb", { path: "b.ts", line: 9 }),
      draft("ccc", { path: "b.ts", line: 2 }),
      draft("dddd", { body: "Note" }),
    ];
    expect(groupDrafts(drafts, ["b.ts"]).map((g) => [g.path, g.drafts.map((d) => d.id)])).toEqual([
      ["", ["dddd"]],
      ["b.ts", ["ccc", "bb"]],
      ["z.ts", ["a"]],
    ]);
    expect(reviewBody("  Mine ", drafts)).toBe("Mine\n\nNote");
    expect(whereText({ path: "a.ts", line: 9, startLine: 4 })).toBe("a.ts, lines 4–9");
    expect(whereText({ path: "a.ts", line: 9 })).toBe("a.ts, line 9");
    expect(whereText({})).toBe("the review body");
    expect([parseLines("12"), parseLines(" 4 - 9 "), parseLines("4–4"), parseLines("9-4"), parseLines("0")]).toEqual([
      { line: 12 },
      { startLine: 4, line: 9 },
      { line: 4 },
      undefined,
      undefined,
    ]);
    expect(cannotSend("APPROVE", "", [])).toBeUndefined();
    expect(cannotSend("COMMENT", "", [])).toBe("Write a comment or a review body first.");
    expect(cannotSend("COMMENT", "", [draft("a", { state: "outdated" }), draft("b", { state: "outdated" })])).toBe(
      "Rewrite or delete the 2 outdated comments first.",
    );
  });

  it("builds a linked note's body with its link, as the server does", () => {
    const note = draft("a", { body: "Retry here too?", linkTo: { path: "py/orders/tasks.py", line: 5 } });
    expect(reviewBody("Looks good.", [note])).toBe(
      "Looks good.\n\n**[`py/orders/tasks.py` line 5](https://github.com/acme/api/blob/abc/py/orders/tasks.py#L5)**: Retry here too?",
    );
    expect(linkedText(note)).toBe("links to py/orders/tasks.py, line 5");
    expect(linkedText(draft("b", { linkTo: { path: "a.ts", line: 9, startLine: 4 } }))).toBe(
      "links to a.ts, lines 4–9",
    );
    expect(cannotSend("COMMENT", "", [note])).toBeUndefined();
  });

  it("tells which places go in the review body, as the server will", () => {
    const diff: PrDiff = {
      headSha: "abc",
      files: [
        {
          path: "a.ts",
          status: "modified",
          hunks: [
            {
              header: "@@ -1,2 +1,2 @@",
              lines: [
                { kind: "del", oldLine: 1, text: "x" },
                { kind: "add", newLine: 1, text: "y" },
                { kind: "ctx", oldLine: 2, newLine: 2, text: "z" },
              ],
            },
            { header: "@@ -20 +20 @@", lines: [{ kind: "add", newLine: 20, text: "w" }] },
          ],
        },
        { path: "big.json", status: "modified", patchMissing: true, hunks: [] },
      ],
    };
    const inBody = (place: Parameters<typeof goesInBody>[1]) => goesInBody(diff, place);
    expect([
      inBody({ path: "a.ts", line: 1 }),
      inBody({ path: "a.ts", line: 2, startLine: 1 }),
      inBody({ path: "a.ts", line: 1, side: "LEFT" }),
    ]).toEqual([false, false, undefined]);
    expect([
      inBody({ path: "a.ts", line: 5 }),
      inBody({ path: "a.ts", line: 20, startLine: 2 }),
      inBody({ path: "b.ts", line: 1 }),
      inBody({ path: "big.json", line: 1 }),
      inBody({ path: "a.ts" }),
    ]).toEqual([true, true, true, true, true]);
    // Without the diff only a whole file is known; the server decides the rest.
    expect([goesInBody(undefined, { path: "a.ts", line: 5 }), goesInBody(undefined, { path: "a.ts" })]).toEqual([
      undefined,
      true,
    ]);
    expect(linkedNotice({ line: 5 })).toBe(
      "This line isn't in the PR's diff, so it goes in the review body with a link to it.",
    );
    expect(linkedNotice({ line: 9, startLine: 4 })).toMatch(/^These lines aren't in the PR's diff/);
  });

  it("calls the drafts routes with the session key", async () => {
    const seen: string[] = [];
    const api = new Api("tok", async (input, init) => {
      const headers = init?.headers as Record<string, string>;
      seen.push(`${init?.method ?? "GET"} ${String(input)} ${headers["X-Alden-Token"]} ${init?.body ?? ""}`.trim());
      return new Response(JSON.stringify({ drafts: [], unaddressed: [] }));
    });
    await api.drafts(PR);
    await api.addDraft({ pr: PR, path: "a.ts", line: 1, side: "RIGHT", body: "x" });
    await api.editDraft("d/1", "y");
    await api.editDraft("d2", { body: "z", suggestion: null });
    await api.deleteDraft("d1");
    await api.sendReview({ pr: PR, event: "COMMENT" });
    expect(seen).toEqual([
      "GET /api/drafts?pr=acme%2Fapi%231 tok",
      `POST /api/drafts tok {"pr":"acme/api#1","path":"a.ts","line":1,"side":"RIGHT","body":"x"}`,
      `PATCH /api/drafts/d%2F1 tok {"body":"y"}`,
      `PATCH /api/drafts/d2 tok {"body":"z","suggestion":null}`,
      "DELETE /api/drafts/d1 tok",
      `POST /api/review/send tok {"pr":"acme/api#1","event":"COMMENT"}`,
    ]);
  });
});
