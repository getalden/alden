// @vitest-environment jsdom
import type { Briefing } from "@alden/schema";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Api, ApiError } from "../api";
import {
  cannotSend,
  groupDrafts,
  type NewDraft,
  type ReviewDraft,
  type ReviewEvent,
  reviewBody,
  type SendReviewResult,
  type Unaddressed,
  useDrafts,
} from "../drafts";
import { BriefingView } from "./BriefingView";
import { QueueView } from "./QueueView";

afterEach(cleanup);

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
  const state = { drafts: [...start], unaddressed, calls: [] as string[], sendError: undefined as string | undefined };
  let next = 0;
  const api = {
    drafts: async (pr: string) => {
      state.calls.push(`GET ${pr}`);
      return { drafts: [...state.drafts], unaddressed: state.unaddressed };
    },
    addDraft: async (input: NewDraft & { pr: string }) => {
      state.calls.push(`POST ${JSON.stringify(input)}`);
      const saved = draft(`n${next++}`, { ...input, body: input.body });
      state.drafts.push(saved);
      return saved;
    },
    editDraft: async (id: string, body: string) => {
      state.calls.push(`PATCH ${id} ${body}`);
      state.drafts = state.drafts.map((d) => (d.id === id ? { ...d, body } : d));
      return state.drafts.find((d) => d.id === id) as ReviewDraft;
    },
    deleteDraft: async (id: string) => {
      state.calls.push(`DELETE ${id}`);
      state.drafts = state.drafts.filter((d) => d.id !== id);
      return { ok: true as const };
    },
    sendReview: async (review: { pr: string; event: ReviewEvent; body?: string }): Promise<SendReviewResult> => {
      state.calls.push(`SEND ${JSON.stringify(review)}`);
      if (state.sendError) throw new ApiError(422, state.sendError);
      const posted = state.drafts.filter((d) => d.path).length;
      state.drafts = [];
      return { url: "https://github.com/acme/api/pull/1#pullrequestreview-9", posted, review: review.event };
    },
  } as unknown as Api;
  return { api, state };
}

function Harness({ api, b = briefing }: { api: Api; b?: Briefing }) {
  const comments = useDrafts(api, PR);
  return <BriefingView briefing={b} comments={comments} />;
}

async function setup(start: ReviewDraft[] = [], unaddressed: Unaddressed[] = []) {
  const fake = fakeApi(start, unaddressed);
  const view = render(<Harness api={fake.api} />);
  await waitFor(() => expect(fake.state.calls).toContain(`GET ${PR}`));
  await screen.findByRole("heading", { name: "Review" });
  return { ...fake, view };
}

const key = (k: string, target: EventTarget = document.body, extra: KeyboardEventInit = {}) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));
  });

describe("commenting on a place", () => {
  it("opens an editor on a place in Needs your eyes, saves with Ctrl+Enter, and gives focus back", async () => {
    const { state } = await setup();
    // The place in Needs your eyes and the check's evidence line both have a line; the whole-file one doesn't.
    const buttons = screen.getAllByRole("button", { name: "Comment on src/api.ts:9" });
    expect(buttons).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Comment on src\/web\.ts/ })).toBeNull();
    fireEvent.click(buttons[0] as HTMLElement);
    const area = screen.getByRole("textbox", { name: "Comment on src/api.ts:9" });
    expect(document.activeElement).toBe(area);
    fireEvent.change(area, { target: { value: "Does the web client pass a currency?" } });
    fireEvent.keyDown(area, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(state.calls).toContain(
        `POST ${JSON.stringify({ pr: PR, path: "src/api.ts", line: 9, side: "RIGHT", body: "Does the web client pass a currency?" })}`,
      ),
    );
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Comment on src/api.ts:9" })).toBeNull());
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("Comment on src/api.ts:9");
    // It shows at the place and in the Review panel, under its file.
    expect(screen.getAllByRole("list", { name: "Your comments on src/api.ts:9" })).toHaveLength(2);
    const group = screen.getByRole("region", { name: "src/api.ts" });
    expect(within(group).getByText("Does the web client pass a currency?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send review · 1 comment" })).toBeTruthy();
  });

  it("cancels with Escape and keeps nothing", async () => {
    const { state } = await setup();
    fireEvent.click(screen.getAllByRole("button", { name: "Comment on src/api.ts:9" })[1] as HTMLElement);
    const area = screen.getByRole("textbox", { name: "Comment on src/api.ts:9" });
    fireEvent.change(area, { target: { value: "never mind" } });
    fireEvent.keyDown(area, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Comment on src/api.ts:9" })).toBeNull();
    expect(state.calls.some((c) => c.startsWith("POST"))).toBe(false);
  });

  it("keeps the text and says why when saving fails", async () => {
    const { api } = fakeApi();
    (api as unknown as { addDraft: () => Promise<never> }).addDraft = async () => {
      throw new ApiError(400, "That line isn't in the diff.");
    };
    render(<Harness api={api} />);
    await screen.findByRole("heading", { name: "Review" });
    fireEvent.click(screen.getAllByRole("button", { name: "Comment on src/api.ts:9" })[0] as HTMLElement);
    const area = screen.getByRole("textbox", { name: "Comment on src/api.ts:9" });
    fireEvent.change(area, { target: { value: "Keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That line isn't in the diff.");
    expect((area as HTMLTextAreaElement).value).toBe("Keep me");
  });
});

describe("comment keys", () => {
  it("c comments on the place you're on, or opens Comment on a line; s goes to the Review panel; typing never triggers them", async () => {
    await setup();
    // On a place: c opens its editor.
    const button = screen.getAllByRole("button", { name: "Comment on src/api.ts:9" })[0] as HTMLElement;
    button.focus();
    key("c", button);
    const area = screen.getByRole("textbox", { name: "Comment on src/api.ts:9" });
    expect(document.activeElement).toBe(area);
    // In a textarea, c and s are just letters.
    key("c", area);
    key("s", area);
    expect(document.activeElement).toBe(area);
    expect(screen.queryByRole("combobox", { name: "File" })).toBeNull();
    fireEvent.keyDown(area, { key: "Escape" });

    // Nowhere in particular: c opens Comment on a line, with the file picker focused.
    (document.activeElement as HTMLElement).blur();
    key("c");
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "File" }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Comment on a line…" }));

    key("s");
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Review" }));
    // With a modifier, the browser's own shortcut wins.
    key("c", document.body, { metaKey: true });
    expect(screen.queryByRole("combobox", { name: "File" })).toBeNull();
  });
});

describe("Comment on a line and general notes", () => {
  it("comments on any line of a changed file, the old side for a removed file, and adds a general note", async () => {
    const { state } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Comment on a line…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Why 3?" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Give a line number.");
    fireEvent.change(screen.getByRole("textbox", { name: "Line" }), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(state.calls).toContain(
        `POST ${JSON.stringify({ pr: PR, path: "src/charge.ts", line: 12, side: "RIGHT", body: "Why 3?" })}`,
      ),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Comment on a line…" }));
    fireEvent.change(screen.getByRole("combobox", { name: "File" }), { target: { value: "src/old.ts" } });
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
    // Grouped: general notes first, then files in the briefing's order.
    await waitFor(() =>
      expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
        "General notes",
        "src/charge.ts",
        "src/old.ts",
      ]),
    );
  });
});

describe("the Review panel", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Edit comment on src/charge.ts:3" }));
    const edit = screen.getByRole("textbox", { name: "Edit comment on src/charge.ts:3" });
    fireEvent.change(edit, { target: { value: "Rounding? Use cents." } });
    fireEvent.keyDown(edit, { key: "Enter", metaKey: true });
    await waitFor(() => expect(state.calls).toContain("PATCH a Rounding? Use cents."));
    await screen.findByText("Rounding? Use cents.");

    fireEvent.click(screen.getByRole("button", { name: "Rewrite" }));
    expect((screen.getByRole("combobox", { name: "File" }) as HTMLSelectElement).value).toBe("src/charge.ts");
    expect((screen.getByRole("textbox", { name: "Line" }) as HTMLInputElement).value).toBe("1");
    fireEvent.change(screen.getByRole("textbox", { name: "Line" }), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(state.calls).toContain("DELETE bb"));
    expect(state.calls).toContain(
      `POST ${JSON.stringify({ pr: PR, path: "src/charge.ts", line: 2, side: "RIGHT", body: "Old line" })}`,
    );
    await waitFor(() => expect(screen.queryByText("Outdated")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Delete comment on general note" }));
    expect(screen.getByText("Delete this comment?")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(state.calls).toContain("DELETE ccc"));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Send review · 2 comments" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
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
    expect(document.activeElement).toBe(
      within(summary).getByRole("heading", { name: "Send this review to acme/api#1?" }),
    );
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

    // Esc goes back, keeping everything; then send for real.
    fireEvent.keyDown(within(summary).getByRole("button", { name: "Back" }), { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Send this review to acme/api#1?" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send review · 2 comments" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve on GitHub" }));

    const sent = await screen.findByRole("status");
    expect(sent.textContent).toContain("Sent to GitHub.");
    expect(sent.textContent).toContain("You approved with 1 comment.");
    expect(within(sent).getByRole("link", { name: "See the review ↗" }).getAttribute("href")).toBe(
      "https://github.com/acme/api/pull/1#pullrequestreview-9",
    );
    expect(state.calls).toContain(`SEND ${JSON.stringify({ pr: PR, event: "APPROVE", body: "Looks right." })}`);
    expect(state.calls.filter((c) => c.startsWith("SEND"))).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Send review" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Review body" }) as HTMLTextAreaElement).value).toBe("");
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
    expect(screen.getByRole("button", { name: "Send review · 1 comment" })).toBeTruthy();
    expect(screen.getByText("Body a")).toBeTruthy();
  });

  it("needs a body to request changes", async () => {
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    const send = screen.getByRole("button", { name: "Send review" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Review body" }), { target: { value: "Needs tests." } });
    expect(send.disabled).toBe(false);
  });

  it("isn't offered for your local changes, or on another PR's briefing", async () => {
    const { api } = fakeApi();
    const local: Briefing = { ...briefing, target: { kind: "local", repoRoot: "/r", branch: "main" } };
    const { rerender } = render(<Harness api={api} b={local} />);
    expect(screen.queryByRole("heading", { name: "Review" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Comment on/ })).toBeNull();
    rerender(
      <Harness api={api} b={{ ...briefing, target: { ...briefing.target, number: 2 } as Briefing["target"] }} />,
    );
    expect(screen.queryByRole("heading", { name: "Review" })).toBeNull();
  });
});

describe("drafts on the queue", () => {
  it("shows a chip on a PR with drafts", () => {
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
        repoFilter=""
        onRepoFilter={() => {}}
        onRefresh={() => {}}
        selected={undefined}
        drafts={{ "acme/api#1": 2 }}
      />,
    );
    expect(screen.getByText("2 drafts")).toBeTruthy();
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
    expect(cannotSend("APPROVE", "", [])).toBeUndefined();
    expect(cannotSend("COMMENT", "", [])).toBe("Write a comment or a review body first.");
    expect(cannotSend("COMMENT", "", [draft("a", { state: "outdated" }), draft("b", { state: "outdated" })])).toBe(
      "Rewrite or delete the 2 outdated comments first.",
    );
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
    await api.deleteDraft("d1");
    await api.sendReview({ pr: PR, event: "COMMENT" });
    expect(seen).toEqual([
      "GET /api/drafts?pr=acme%2Fapi%231 tok",
      `POST /api/drafts tok {"pr":"acme/api#1","path":"a.ts","line":1,"side":"RIGHT","body":"x"}`,
      `PATCH /api/drafts/d%2F1 tok {"body":"y"}`,
      "DELETE /api/drafts/d1 tok",
      `POST /api/review/send tok {"pr":"acme/api#1","event":"COMMENT"}`,
    ]);
  });
});
