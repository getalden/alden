// @vitest-environment jsdom
import type { PrDiff, ReviewThread } from "@alden/schema";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, ReviewRequest } from "../api";
import { clearDiffCache } from "../diff";
import {
  type BriefingComments,
  type DraftPatch,
  type NewDraft,
  type ReviewDraft,
  reviewBody,
  type SendReviewResult,
  useDrafts,
} from "../drafts";
import { replyWhere, sortThreads, threadPlace } from "../threads";
import { ReviewActionsContext } from "./Comments";
import { DiffThreadsProvider } from "./DiffThreads";
import { DiffView } from "./DiffView";
import { ReviewPane } from "./ReviewPane";

afterEach(() => {
  cleanup();
  clearDiffCache();
  window.sessionStorage.clear();
});
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  window.sessionStorage.setItem("alden.comments.drawer", "1");
});

const PR = "acme/api#1";

const comment = (author: string, body: string, isYou = false) => ({
  id: `C_${author}_${body.length}`,
  databaseId: 1,
  author,
  isYou,
  body,
  createdAt: "2026-10-01T10:00:00.000Z",
  url: "https://github.com/acme/api/pull/1#discussion_r1",
});

const thread = (id: string, extra: Partial<ReviewThread> = {}): ReviewThread => ({
  id,
  path: "src/charge.ts",
  line: 3,
  startLine: null,
  originalLine: 3,
  side: "RIGHT",
  isResolved: false,
  isOutdated: false,
  startedByYou: false,
  viewerCanReply: true,
  viewerCanResolve: true,
  comments: [comment("ana", "Why log cents?")],
  ...extra,
});

const THREADS = [
  thread("T_others"),
  thread("T_mine", { line: 40, startedByYou: true, comments: [comment("me", "Cents?", true), comment("ana", "Yes")] }),
  thread("T_done", { line: 2, isResolved: true }),
  thread("T_locked", { line: 9, viewerCanResolve: false }),
];

const draft = (id: string, extra: Partial<ReviewDraft> = {}): ReviewDraft => ({
  id,
  pr: PR,
  headSha: "abc",
  body: `Body ${id}`,
  source: "you",
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-01T10:00:00Z",
  state: "draft",
  ...extra,
});

/** The local API's drafts and threads routes, in memory. */
function fakeApi(start: ReviewDraft[] = []) {
  const state = { drafts: [...start], calls: [] as string[] };
  let next = 0;
  const api = {
    drafts: async () => ({ drafts: [...state.drafts], unaddressed: [] }),
    threads: async (pr: string, refresh = false) => {
      state.calls.push(`THREADS ${pr}${refresh ? " refresh" : ""}`);
      return { schemaVersion: 1, pr, headSha: "abc", viewer: "me", threads: THREADS };
    },
    addDraft: async (input: NewDraft & { pr: string }) => {
      state.calls.push(`POST ${JSON.stringify(input)}`);
      const { pr: _pr, ...rest } = input;
      const saved = draft(`r${next++}`, { ...rest, resolve: input.resolve === true });
      state.drafts.push(saved);
      return saved;
    },
    editDraft: async (id: string, patch: DraftPatch) => {
      state.calls.push(`PATCH ${id} ${JSON.stringify(patch)}`);
      state.drafts = state.drafts.map((d) => (d.id === id ? { ...d, ...patch } : d)) as ReviewDraft[];
      return state.drafts.find((d) => d.id === id) as ReviewDraft;
    },
    deleteDraft: async (id: string) => {
      state.calls.push(`DELETE ${id}`);
      state.drafts = state.drafts.filter((d) => d.id !== id);
      return { ok: true as const };
    },
    sendReview: async (): Promise<SendReviewResult> => {
      state.calls.push("SEND");
      state.drafts = [];
      return { url: "https://github.com/acme/api/pull/1#r", posted: 1, review: "COMMENT", replies: 1, resolved: 1 };
    },
  } as unknown as Api;
  return { api, state };
}

function Harness({ api }: { api: Api }) {
  const comments = useDrafts(api, PR);
  const request = { pr: PR } as ReviewRequest;
  return (
    <ReviewPane
      crumbs={null}
      title="Change the charge API"
      run={undefined}
      controls={null}
      onStart={() => {}}
      onCancel={() => {}}
      request={request}
      emptyHint=""
      comments={comments}
    />
  );
}

const drawer = () => screen.getByRole("complementary", { name: "Comments" });
const conversation = () => within(drawer()).getByRole("region", { name: /^Conversation/ });

async function setup(start: ReviewDraft[] = []) {
  const fake = fakeApi(start);
  render(<Harness api={fake.api} />);
  await waitFor(() => expect(within(conversation()).getAllByRole("listitem").length).toBeGreaterThan(0));
  return fake;
}

describe("threads helpers", () => {
  it("sorts yours first, then open before resolved, and says where a reply goes", () => {
    expect(sortThreads(THREADS).map((t) => t.id)).toEqual(["T_mine", "T_others", "T_locked", "T_done"]);
    expect(threadPlace(thread("x", { line: 40, startLine: 38 }))).toBe("src/charge.ts:38–40");
    expect(threadPlace(thread("x", { line: null, originalLine: 7 }))).toBe("src/charge.ts:7");
    expect(replyWhere({ body: "Done", resolve: false }, thread("x", { line: 40 }))).toBe(
      "Reply in thread on src/charge.ts:40",
    );
    expect(replyWhere({ body: "Done", resolve: true }, thread("x", { line: 40 }))).toBe(
      "Reply in thread on src/charge.ts:40, and resolve it",
    );
    expect(replyWhere({ body: " ", resolve: true }, thread("x"))).toBe("Resolve the thread on src/charge.ts:3");
    // A reply isn't a note in the review body.
    expect(reviewBody("Top", [draft("r", { inReplyTo: "T", body: "Fixed" }), draft("n", { body: "Note" })])).toBe(
      "Top\n\nNote",
    );
  });
});

describe("the conversation in the Comments drawer", () => {
  it("lists the PR's threads, yours first, open ones before the folded resolved ones", async () => {
    await setup();
    const places = [...conversation().querySelectorAll(".thread .draft-where")].map((e) => e.textContent);
    expect(places).toEqual(["On src/charge.ts:40", "On src/charge.ts:3", "On src/charge.ts:9"]);
    expect(within(conversation()).getByRole("heading", { name: "Conversation · 3 open" })).toBeTruthy();
    expect(conversation().textContent).toContain("You");
    expect(conversation().textContent).toContain("Why log cents?");
    fireEvent.click(within(conversation()).getByRole("button", { name: "Show 1 resolved thread" }));
    expect(within(conversation()).getByText("Resolved")).toBeTruthy();
    // GitHub won't let you resolve that one: the tick is there, but off.
    const ticks = within(conversation()).getAllByRole("checkbox", { name: "Resolve when sent" }) as HTMLInputElement[];
    expect(ticks.map((t) => t.disabled)).toEqual([false, false, true]);
  });

  it("drafts a reply and a resolve, says where each will post, and sends them with the review", async () => {
    const { state } = await setup();
    fireEvent.click(within(conversation()).getByRole("button", { name: "Reply in the thread on src/charge.ts:40" }));
    const box = within(conversation()).getByRole("textbox", { name: "Reply in the thread on src/charge.ts:40" });
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "Fixed in 3f2c." } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(state.calls).toContain(`POST ${JSON.stringify({ pr: PR, inReplyTo: "T_mine", body: "Fixed in 3f2c." })}`),
    );
    const [tick] = within(conversation()).getAllByRole("checkbox", { name: "Resolve when sent" });
    fireEvent.click(tick as HTMLElement);
    await waitFor(() =>
      expect(state.calls).toContain(`PATCH r0 ${JSON.stringify({ body: "Fixed in 3f2c.", resolve: true })}`),
    );
    // Resolve alone, on another thread: a reply with nothing to say.
    fireEvent.click(within(conversation()).getAllByRole("checkbox", { name: "Resolve when sent" })[1] as HTMLElement);
    await waitFor(() =>
      expect(state.calls).toContain(
        `POST ${JSON.stringify({ pr: PR, inReplyTo: "T_others", body: "", resolve: true })}`,
      ),
    );

    const replies = await within(drawer()).findByRole("region", { name: "Replies in threads · 2" });
    expect(replies.textContent).toContain("Reply in thread on src/charge.ts:40, and resolve it");
    expect(replies.textContent).toContain("Resolve the thread on src/charge.ts:3");
    // Not in the review body.
    expect(within(drawer()).queryByRole("region", { name: /In the review body/ })).toBeNull();

    fireEvent.click(within(drawer()).getByRole("button", { name: "Send review · 2 comments" }));
    const summary = await screen.findByRole("region", { name: "Send this review to acme/api#1?" });
    expect(summary.textContent).toContain(", with 1 reply in threads");
    expect(summary.textContent).toContain("Reply in thread on src/charge.ts:40, and resolve it");
    fireEvent.click(within(summary).getByRole("button", { name: "Send to GitHub" }));
    const sent = await within(drawer()).findByRole("status");
    expect(sent.textContent).toContain("and resolved 1 thread");
    // The conversation is read again from GitHub: your reply and resolve are there now.
    await waitFor(() => expect(state.calls).toContain(`THREADS ${PR} refresh`));
  });

  it("drops a reply when its text is discarded and Resolve isn't ticked", async () => {
    const { state } = await setup([draft("r9", { inReplyTo: "T_others", body: "Hm", resolve: false })]);
    await waitFor(() => expect(conversation().textContent).toContain("Your reply · posts with your review"));
    fireEvent.click(
      within(conversation()).getByRole("button", { name: "Discard your reply in the thread on src/charge.ts:3" }),
    );
    await waitFor(() => expect(state.calls).toContain("DELETE r9"));
  });
});

describe("threads at their lines in the Diff tab", () => {
  const diff: PrDiff = {
    headSha: "abc",
    files: [
      {
        path: "src/charge.ts",
        status: "modified",
        additions: 2,
        deletions: 0,
        hunks: [
          {
            header: "@@ -1,2 +1,4 @@",
            lines: [
              { kind: "ctx", oldLine: 1, newLine: 1, text: "a" },
              { kind: "add", newLine: 2, text: "b" },
              { kind: "add", newLine: 3, text: "c" },
              { kind: "ctx", oldLine: 2, newLine: 4, text: "d" },
            ],
          },
        ],
      },
    ],
  };

  it("shows each thread under its line, folded when resolved, with Reply opening the drawer's box", () => {
    const onReply = vi.fn();
    const comments = {
      pr: PR,
      drafts: [draft("r1", { inReplyTo: "T_others", body: "Fixed" })],
      threads: { threads: THREADS, loading: false, error: undefined, reload: async () => {} },
    } as unknown as BriefingComments;
    render(
      <ReviewActionsContext.Provider value={{ onComment: () => {}, onFinish: () => {}, onReply }}>
        <DiffThreadsProvider comments={comments} pr={PR}>
          <DiffView diff={diff} />
        </DiffThreadsProvider>
      </ReviewActionsContext.Provider>,
    );
    const rows = document.querySelectorAll("tr.diff-thread-row");
    // Line 3 (open) and line 2 (resolved); line 40 and line 9 aren't in this diff.
    expect(rows).toHaveLength(2);
    const resolved = within(rows[0] as HTMLElement).getByRole("button", { name: /ana · 1 comment · resolved/ });
    expect(resolved.getAttribute("aria-expanded")).toBe("false");
    const open = rows[1] as HTMLElement;
    expect(open.textContent).toContain("Why log cents?");
    expect(open.textContent).toContain("Drafted: Reply in thread on src/charge.ts:3. It posts with your review.");
    fireEvent.click(within(open).getByRole("button", { name: "Edit reply" }));
    expect(onReply).toHaveBeenCalledWith("T_others");
  });

  it("shows nothing for another PR's threads", () => {
    const comments = {
      pr: "acme/api#2",
      drafts: [],
      threads: { threads: THREADS, loading: false, error: undefined, reload: async () => {} },
    } as unknown as BriefingComments;
    render(
      <DiffThreadsProvider comments={comments} pr={PR}>
        <DiffView diff={diff} />
      </DiffThreadsProvider>,
    );
    expect(document.querySelectorAll("tr.diff-thread-row")).toHaveLength(0);
  });
});
