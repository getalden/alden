// @vitest-environment jsdom
import type { Briefing, ReviewThread } from "@alden/schema";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Api, ApiError, type DraftReviewResult, type ReviewRequest, type SuggestTextRequest } from "../api";
import { type DraftPatch, type NewDraft, type ReviewDraft, useDrafts } from "../drafts";
import { draftReviewOutcome, INJECTED_DRAFTING } from "./AldenAssist";
import { ReviewPane } from "./ReviewPane";

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  window.sessionStorage.setItem("alden.comments.drawer", "1");
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
    headSha: "abc",
  },
  generatedAt: "2026-09-30T10:00:00Z",
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
  needsYourEyes: [{ title: "No tests", reason: "nothing tests it." }],
  notChecked: [],
};

const INJECTED: Briefing["checks"][number] = {
  id: "injection.ai",
  title: "Text aimed at AI reviewers",
  status: "flagged",
  severity: "high",
  summary: "1 place.",
  evidence: [],
  heuristic: true,
};

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

const THREAD: ReviewThread = {
  id: "T_1",
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
  comments: [
    {
      id: "C1",
      databaseId: 1,
      author: "ana",
      isYou: false,
      body: "Why cents?",
      createdAt: "2026-10-01T10:00:00Z",
      url: "https://github.com/acme/api/pull/1#discussion_r1",
    },
  ],
};

/** The local API's drafts and drafting routes, in memory: no model, no GitHub. */
function fakeApi() {
  const state = {
    drafts: [] as ReviewDraft[],
    calls: [] as string[],
    review: { made: 1, skipped: 1, asked: 2, costUsd: 0.0123, drafts: [] } as DraftReviewResult,
    reviewError: undefined as string | undefined,
    text: "Is this amount in cents?",
    /** Holds the next suggestion until released, to test Cancel. */
    hold: undefined as Promise<void> | undefined,
    signals: [] as AbortSignal[],
  };
  let next = 0;
  const api = {
    drafts: async () => ({ drafts: [...state.drafts], unaddressed: [] }),
    threads: async (pr: string) => ({ schemaVersion: 1, pr, headSha: "abc", viewer: "me", threads: [THREAD] }),
    addDraft: async (input: NewDraft & { pr: string }) => {
      state.calls.push(`POST ${JSON.stringify(input)}`);
      const { pr: _pr, ...rest } = input;
      const saved = draft(`n${next++}`, rest);
      state.drafts.push(saved);
      return saved;
    },
    editDraft: async (id: string, patch: DraftPatch) => {
      state.calls.push(`PATCH ${id} ${JSON.stringify(patch)}`);
      return state.drafts.find((d) => d.id === id) as ReviewDraft;
    },
    deleteDraft: async () => ({ ok: true as const }),
    sendReview: async () => ({ url: "u", posted: 0, review: "COMMENT" as const }),
    draftReview: async (pr: string) => {
      state.calls.push(`DRAFT ${pr}`);
      if (state.reviewError) throw new ApiError(409, state.reviewError);
      state.drafts.push(
        draft("a1", { source: "alden", body: "Add a test.", drafted: { checkId: "tests.missing", title: "No tests" } }),
      );
      return state.review;
    },
    suggestText: async (input: SuggestTextRequest, signal?: AbortSignal) => {
      state.calls.push(`SUGGEST ${JSON.stringify(input)}`);
      if (signal) state.signals.push(signal);
      if (state.hold) await state.hold;
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return { text: state.text, costUsd: 0.0021 };
    },
  } as unknown as Api;
  return { api, state };
}

function Harness(props: { api: Api; b?: Briefing | undefined; model?: boolean; onSetUpModel?: () => void }) {
  const comments = useDrafts(props.api, PR);
  const request = { pr: PR } as ReviewRequest;
  const b = "b" in props ? props.b : briefing;
  return (
    <ReviewPane
      crumbs={null}
      title="Change the charge API"
      run={b ? { stages: [], running: false, startedAt: 0, briefing: b, request } : undefined}
      controls={null}
      onStart={() => {}}
      onCancel={() => {}}
      request={request}
      emptyHint=""
      comments={comments}
      assist={{
        api: props.api,
        model: props.model ?? true,
        ...(props.onSetUpModel ? { onSetUpModel: props.onSetUpModel } : {}),
      }}
    />
  );
}

const drawer = () => screen.getByRole("complementary", { name: "Comments" });
const toolbar = () => screen.getByRole("toolbar", { name: "Review options" });

async function setup(props: Omit<Parameters<typeof Harness>[0], "api"> = {}) {
  const fake = fakeApi();
  render(<Harness api={fake.api} {...props} />);
  await waitFor(() => expect(within(drawer()).getByText(/No comments yet/)).toBeTruthy());
  return fake;
}

describe("Draft my review", () => {
  it("drafts from the toolbar, shows the drafts in the drawer, and says what it made, skipped and cost", async () => {
    const { state } = await setup();
    fireEvent.click(within(toolbar()).getByRole("button", { name: "Draft my review" }));
    expect(within(toolbar()).getByRole("button", { name: "Drafting…" })).toBeTruthy();
    await waitFor(() =>
      expect(within(toolbar()).getByRole("status").textContent).toBe(
        "Alden drafted 1 comment ($0.01): keep, edit or drop each in Comments. Skipped 1 place with a comment or draft near it already.",
      ),
    );
    expect(state.calls).toEqual([`DRAFT ${PR}`]);
    expect(within(drawer()).getByText("Add a test.")).toBeTruthy();
    // Alden's draft, suggested until you keep it.
    const card = within(drawer()).getByText("Add a test.").closest("li") as HTMLElement;
    expect(card.querySelector(".dcard-who")?.textContent).toBe("Alden");
    expect(card.querySelector(".dcard-state")?.textContent).toBe("suggested");
  });

  it("is in the drawer too, and says why when it couldn't draft", async () => {
    const { state } = await setup();
    state.reviewError = "Brief acme/api#1 first: Alden drafts from the briefing's places to look.";
    fireEvent.click(within(drawer()).getByRole("button", { name: "Draft my review" }));
    expect((await within(drawer()).findByRole("alert")).textContent).toBe(state.reviewError);
  });

  it("never asks for a PR with text aimed at AI reviewers, and says why", async () => {
    const { state } = await setup({ b: { ...briefing, checks: [INJECTED] } });
    const button = within(toolbar()).getByRole("button", { name: "Draft my review" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(within(toolbar()).getByRole("status").textContent).toBe(INJECTED_DRAFTING);
    expect(state.calls).toEqual([]);
  });

  it("needs a briefing, and without a model the drawer offers to set one up", async () => {
    const onSetUpModel = vi.fn();
    await setup({ model: false, onSetUpModel });
    expect(within(toolbar()).queryByRole("button", { name: "Draft my review" })).toBeNull();
    fireEvent.click(within(drawer()).getByRole("button", { name: "Set up a model" }));
    expect(onSetUpModel).toHaveBeenCalled();
    cleanup();
    await setup({ b: undefined });
    expect(screen.queryByRole("button", { name: "Draft my review" })).toBeNull();
  });

  it("says plainly when there was nothing to draft", () => {
    expect(draftReviewOutcome({ made: 0, skipped: 3, asked: 0, costUsd: null })).toBe(
      "Nothing new to draft: every place to look has a comment or draft near it already.",
    );
    expect(draftReviewOutcome({ made: 0, skipped: 0, asked: 2, costUsd: 0.004 })).toBe(
      "The model found nothing worth a comment at those places ($0.0040).",
    );
  });
});

describe("Draft with Alden in a comment box", () => {
  const openNote = () => {
    fireEvent.click(within(drawer()).getByRole("button", { name: "Add a general note" }));
    return within(drawer()).getByRole("textbox", { name: "General note" }) as HTMLTextAreaElement;
  };

  it("fills an empty box for you to edit, saves nothing by itself, and counts the save as assisted", async () => {
    const { state } = await setup();
    const box = openNote();
    fireEvent.click(within(drawer()).getByRole("button", { name: "Draft with Alden" }));
    await waitFor(() => expect(box.value).toBe("Is this amount in cents?"));
    expect(state.calls).toEqual([`SUGGEST ${JSON.stringify({ pr: PR })}`]);
    expect(within(drawer()).getByRole("status").textContent).toContain("Alden's text ($0.0021)");
    // Undo empties the box again; asking once more fills it.
    fireEvent.click(within(drawer()).getByRole("button", { name: "Undo" }));
    expect(box.value).toBe("");
    fireEvent.click(within(drawer()).getByRole("button", { name: "Draft with Alden" }));
    await waitFor(() => expect(box.value).toBe("Is this amount in cents?"));
    fireEvent.change(box, { target: { value: "Is this amount in cents? It reads like dollars." } });
    fireEvent.click(within(drawer()).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(state.calls.at(-1)).toBe(
        `POST ${JSON.stringify({ pr: PR, body: "Is this amount in cents? It reads like dollars.", assisted: { edited: true } })}`,
      ),
    );
  });

  it("treats what you wrote as your intent, and replaces it only when you choose", async () => {
    const { state } = await setup();
    const box = openNote();
    fireEvent.change(box, { target: { value: "cents??" } });
    fireEvent.click(within(drawer()).getByRole("button", { name: "Draft with Alden" }));
    const offer = await within(drawer()).findByRole("region", { name: "Alden's version" });
    expect(state.calls).toEqual([`SUGGEST ${JSON.stringify({ pr: PR, text: "cents??" })}`]);
    expect(box.value).toBe("cents??");
    fireEvent.click(within(offer).getByRole("button", { name: "Keep mine" }));
    expect(box.value).toBe("cents??");
    fireEvent.click(within(drawer()).getByRole("button", { name: "Draft with Alden" }));
    fireEvent.click(
      within(await within(drawer()).findByRole("region", { name: "Alden's version" })).getByText("Use it"),
    );
    expect(box.value).toBe("Is this amount in cents?");
    fireEvent.click(within(drawer()).getByRole("button", { name: "Undo" }));
    expect(box.value).toBe("cents??");
  });

  it("can be cancelled, leaving the box as it was", async () => {
    const { state } = await setup();
    let release = () => {};
    state.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const box = openNote();
    fireEvent.click(within(drawer()).getByRole("button", { name: "Draft with Alden" }));
    fireEvent.click(await within(drawer()).findByRole("button", { name: "Cancel drafting with Alden" }));
    expect(state.signals[0]?.aborted).toBe(true);
    release();
    await waitFor(() => expect(within(drawer()).getByRole("button", { name: "Draft with Alden" })).toBeTruthy());
    expect(box.value).toBe("");
  });

  it("asks for the line a place's comment is on", async () => {
    const { state } = await setup();
    fireEvent.click(within(drawer()).getByRole("button", { name: "Comment on a line…" }));
    fireEvent.change(within(drawer()).getByRole("textbox", { name: "Line" }), { target: { value: "2–3" } });
    fireEvent.click(within(drawer()).getByRole("button", { name: "Draft with Alden" }));
    await waitFor(() =>
      expect(state.calls).toEqual([
        `SUGGEST ${JSON.stringify({ pr: PR, path: "src/charge.ts", line: 3, startLine: 2, side: "RIGHT" })}`,
      ]),
    );
  });

  it("isn't offered without a model, nor on a PR with text aimed at AI reviewers", async () => {
    await setup({ model: false });
    openNote();
    expect(within(drawer()).queryByRole("button", { name: "Draft with Alden" })).toBeNull();
    cleanup();
    await setup({ b: { ...briefing, checks: [INJECTED] } });
    openNote();
    expect(within(drawer()).queryByRole("button", { name: "Draft with Alden" })).toBeNull();
    expect(within(drawer()).getByText(/Alden won't draft here/)).toBeTruthy();
  });
});

describe("Draft with Alden in a reply box", () => {
  it("drafts a reply for the thread, and counts saving it as an assisted reply", async () => {
    const { state } = await setup();
    fireEvent.click(await within(drawer()).findByRole("tab", { name: /^Conversation/ }));
    const conversation = await within(drawer()).findByRole("region", { name: /^Conversation/ });
    fireEvent.click(
      await within(conversation).findByRole("button", { name: "Reply in the thread on src/charge.ts:3" }),
    );
    fireEvent.click(within(conversation).getByRole("button", { name: "Draft with Alden" }));
    const box = within(conversation).getByRole("textbox", {
      name: "Reply in the thread on src/charge.ts:3",
    }) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("Is this amount in cents?"));
    expect(state.calls).toEqual([`SUGGEST ${JSON.stringify({ pr: PR, threadId: "T_1" })}`]);
    fireEvent.click(within(conversation).getByRole("button", { name: "Save reply" }));
    await waitFor(() =>
      expect(state.calls.at(-1)).toBe(
        `POST ${JSON.stringify({ pr: PR, inReplyTo: "T_1", body: "Is this amount in cents?", assisted: { edited: false } })}`,
      ),
    );
  });
});
