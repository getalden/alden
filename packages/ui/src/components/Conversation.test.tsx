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
function fakeApi(start: ReviewDraft[] = [], threads: ReviewThread[] = THREADS) {
  const state = { drafts: [...start], calls: [] as string[] };
  let next = 0;
  const api = {
    drafts: async () => ({ drafts: [...state.drafts], unaddressed: [] }),
    threads: async (pr: string, refresh = false) => {
      state.calls.push(`THREADS ${pr}${refresh ? " refresh" : ""}`);
      return { schemaVersion: 1, pr, headSha: "abc", viewer: "me", threads };
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

function Harness({ api, openThread }: { api: Api; openThread?: { threadId: string; n: number } | undefined }) {
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
      openThread={openThread}
    />
  );
}

const drawer = () => screen.getByRole("complementary", { name: "Comments" });
const conversation = () => within(drawer()).getByRole("region", { name: /^Conversation/ });

async function setup(
  start: ReviewDraft[] = [],
  threads: ReviewThread[] = THREADS,
  openThread?: { threadId: string; n: number },
) {
  const fake = fakeApi(start, threads);
  render(<Harness api={fake.api} openThread={openThread} />);
  // The drawer opens on Drafts; a thread to open on shows Conversation by itself.
  if (!openThread) fireEvent.click(await within(drawer()).findByRole("tab", { name: /^Conversation/ }));
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
    expect(within(drawer()).getByRole("tab", { name: "Conversation 4" }).getAttribute("aria-selected")).toBe("true");
    const heads = [...conversation().querySelectorAll(".tcard-head")].map((e) => [
      e.querySelector(".tcard-where")?.textContent,
      e.querySelector(".tcard-state")?.textContent,
    ]);
    expect(heads).toEqual([
      ["charge.ts:40 · yours", expect.stringMatching(/^replied \d+[mhdw] ago$/)],
      ["charge.ts:3 · open", "open"],
      ["charge.ts:9 · open", "open"],
    ]);
    expect(conversation().querySelector(".tcard-where")?.getAttribute("title")).toBe("src/charge.ts:40");
    expect(within(conversation()).getByRole("heading", { name: "Conversation · 3 open" })).toBeTruthy();
    // Who said it in bold, then what they said.
    const first = conversation().querySelector(".thread-comment") as HTMLElement;
    expect(first.querySelector("b")?.textContent).toBe("you");
    expect(first.textContent).toBe("you Cents?");
    expect(conversation().textContent).toContain("Why log cents?");
    fireEvent.click(within(conversation()).getByRole("button", { name: "Show 1 resolved thread" }));
    expect(conversation().querySelector(".tcard.resolved .tcard-state")?.textContent).toBe("resolved");
    // Only the thread you started has Resolve; the others are theirs to resolve.
    const ticks = within(conversation()).getAllByRole("checkbox", { name: "Resolve when sent" }) as HTMLInputElement[];
    expect(ticks.map((t) => t.disabled)).toEqual([false]);
    expect(within(conversation()).getAllByText("ana's to resolve")).toHaveLength(2);
  });

  it("offers Resolve on a thread you started only where GitHub lets you", async () => {
    await setup([], [thread("T_mine", { startedByYou: true, viewerCanResolve: false })]);
    const tick = within(conversation()).getByRole("checkbox", { name: "Resolve when sent" }) as HTMLInputElement;
    expect(tick.disabled).toBe(true);
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
    // A reply in Ana's thread, which is hers to resolve.
    fireEvent.click(within(conversation()).getByRole("button", { name: "Reply in the thread on src/charge.ts:3" }));
    const theirs = within(conversation()).getByRole("textbox", { name: "Reply in the thread on src/charge.ts:3" });
    fireEvent.change(theirs, { target: { value: "Agreed." } });
    fireEvent.keyDown(theirs, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(state.calls).toContain(`POST ${JSON.stringify({ pr: PR, inReplyTo: "T_others", body: "Agreed." })}`),
    );

    // Where each will post is listed with your drafts.
    fireEvent.click(within(drawer()).getByRole("tab", { name: /^Drafts/ }));
    const replies = await within(drawer()).findByRole("region", { name: "Replies in threads · 2" });
    expect(replies.textContent).toContain("Reply in thread on src/charge.ts:40, and resolve it");
    expect(replies.textContent).toContain("Reply in thread on src/charge.ts:3");
    // Not in the review body.
    expect(within(drawer()).getByRole("region", { name: "In the review body · 0" })).toBeTruthy();

    fireEvent.click(within(drawer()).getByRole("button", { name: "Review and send · 2" }));
    const summary = await screen.findByRole("dialog", { name: "Send this review to GitHub?" });
    expect(summary.textContent).toContain("Replies in threads2 replies");
    expect(summary.textContent).toContain("Resolved after it posts1 thread");
    expect(summary.textContent).toContain("Reply in thread on src/charge.ts:40, and resolve it");
    fireEvent.click(within(summary).getByRole("button", { name: "Send review" }));
    await screen.findByText("Sent to GitHub", { selector: ".sent-toast" });
    // The conversation is read again from GitHub: your reply and resolve are there now.
    await waitFor(() => expect(state.calls).toContain(`THREADS ${PR} refresh`));
  });

  it("starts a reply empty and saves only what you wrote, with Alden's drafts on the thread's line", async () => {
    const alden = "Log the amount, not the cents.";
    const { state } = await setup([
      draft("a1", { path: "src/charge.ts", line: 3, side: "RIGHT", body: alden, source: "alden" }),
      draft("a2", { path: "src/charge.ts", line: 3, side: "RIGHT", body: alden, source: "you" }),
    ]);
    fireEvent.click(within(conversation()).getByRole("button", { name: "Reply in the thread on src/charge.ts:3" }));
    const box = within(conversation()).getByRole("textbox", { name: "Reply in the thread on src/charge.ts:3" });
    expect((box as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(box, { target: { value: "nevermind all good on this one." } });
    fireEvent.click(within(conversation()).getByRole("button", { name: "Save reply" }));
    await waitFor(() => expect(conversation().textContent).toContain("Your reply · posts with your review"));
    expect(state.calls.filter((c) => !c.startsWith("THREADS"))).toEqual([
      `POST ${JSON.stringify({ pr: PR, inReplyTo: "T_others", body: "nevermind all good on this one." })}`,
    ]);
    fireEvent.click(
      within(conversation()).getByRole("button", { name: "Edit your reply in the thread on src/charge.ts:3" }),
    );
    expect(
      (
        within(conversation()).getByRole("textbox", {
          name: "Reply in the thread on src/charge.ts:3",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("nevermind all good on this one.");
  });

  it("opens on the thread a PR was opened for from the queue's news, without starting a reply", async () => {
    window.sessionStorage.removeItem("alden.comments.drawer");
    await setup([], THREADS, { threadId: "T_done", n: 1 });
    // The drawer opens, the resolved thread unfolds, and it's brought into view and focused.
    const shown = () => conversation().querySelector(".thread.shown");
    await waitFor(
      () => {
        expect(shown()).not.toBeNull();
        expect(document.activeElement).toBe(shown());
      },
      { timeout: 3000 },
    );
    expect(shown()?.querySelector(".tcard-state")?.textContent).toBe("resolved");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(within(conversation()).queryByRole("textbox")).toBeNull();
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
