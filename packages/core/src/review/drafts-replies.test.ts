import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewDraftSchema, type ReviewThread } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromRestFile } from "../diff/sources.js";
import type { GitHubClient } from "../github/client.js";
import { sentComments } from "../github/outcomes.js";
import type { RawThread } from "../github/threads.js";
import { AldenStore } from "../store/db.js";
import {
  checkThread,
  composeReviewBody,
  findThread,
  placeOnDiff,
  REPLY_MUTATION,
  RESOLVE_MUTATION,
  ReviewDrafts,
  SendReviewError,
  SUBMIT_MUTATION,
  sendReview,
  shortThreadId,
  threadWhere,
} from "./drafts.js";

const REPO = "acme/shop";
const PR = "acme/shop#7";
const PATCH = [
  "@@ -10,6 +10,7 @@ export function pay()",
  " const a = 1;",
  " const b = 2;",
  "-const total = a + b;",
  "+const total = a + b + fee;",
  "+log(total);",
  " }",
  " ",
].join("\n");
const V1 = fromRestFile({ filename: "src/pay.ts", status: "modified", additions: 2, deletions: 1, patch: PATCH });

let home: string;
let store: AldenStore;
const savedHome = process.env.ALDEN_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "alden-replies-"));
  process.env.ALDEN_HOME = home;
  store = AldenStore.open(join(home, "alden.db"));
});
afterEach(() => {
  store.close();
  if (savedHome === undefined) delete process.env.ALDEN_HOME;
  else process.env.ALDEN_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const placed = () => {
  const p = placeOnDiff([V1], "src/pay.ts", 12);
  if ("problem" in p) throw new Error(p.problem);
  return p;
};

const raw = (id: string, extra: Partial<RawThread> = {}): RawThread => ({
  id,
  path: "src/pay.ts",
  line: 40,
  startLine: null,
  originalLine: 40,
  diffSide: "RIGHT",
  isResolved: false,
  isOutdated: false,
  viewerCanReply: true,
  viewerCanResolve: true,
  comments: {
    nodes: [
      {
        id: `C_${id}`,
        databaseId: 1,
        author: { login: "me" },
        body: "Cents?",
        createdAt: "2026-10-01T10:00:00Z",
        url: "https://github.com/acme/shop/pull/7#discussion_r1",
        // Yours: Alden resolves only threads you started.
        viewerDidAuthor: true,
      },
    ],
  },
  ...extra,
});

const thread = (id: string, extra: Partial<ReviewThread> = {}): ReviewThread => ({
  id,
  path: "src/pay.ts",
  line: 40,
  startLine: null,
  originalLine: 40,
  side: "RIGHT",
  isResolved: false,
  isOutdated: false,
  startedByYou: true,
  viewerCanReply: true,
  viewerCanResolve: true,
  comments: [],
  ...extra,
});

/** GitHub for a send: REST for the PR and reviews, GraphQL for threads and the mutations; every call in order. */
function fakeGitHub(options: { threads?: RawThread[]; fail?: Partial<Record<string, string>> } = {}) {
  const calls: { call: string; params: Record<string, unknown> }[] = [];
  const failIf = (call: string) => {
    const message = options.fail?.[call];
    if (message) throw Object.assign(new Error(message), { status: 422 });
  };
  const client = {
    request: async (route: string, params: Record<string, unknown>) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return { data: { head: { sha: "h1" } } };
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
        return { data: params.page === 1 ? [{ filename: "src/pay.ts", status: "modified", patch: PATCH }] : [] };
      }
      calls.push({ call: route, params });
      failIf(route);
      if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
        return {
          data: { id: 501, node_id: "PRR_501", html_url: "https://github.com/acme/shop/pull/7#pullrequestreview-501" },
        };
      }
      if (route === "DELETE /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}") return { data: {} };
      throw new Error(`unexpected ${route}`);
    },
    graphql: async (query: string, params: Record<string, unknown>) => {
      if (query.includes("reviewThreads")) {
        return { repository: { pullRequest: { headRefOid: "h1", reviewThreads: { nodes: options.threads ?? [] } } } };
      }
      const call =
        query === REPLY_MUTATION
          ? "reply"
          : query === SUBMIT_MUTATION
            ? "submit"
            : query === RESOLVE_MUTATION
              ? "resolve"
              : "?";
      calls.push({ call, params });
      failIf(call);
      if (call === "submit") {
        return { submitPullRequestReview: { pullRequestReview: { url: "https://github.com/acme/shop/pull/7#r-501" } } };
      }
      return {};
    },
  } as unknown as GitHubClient;
  return { client, calls, order: () => calls.map((c) => c.call) };
}

const POST = "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews";
const DELETE = "DELETE /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}";

describe("reply drafts", () => {
  it("are kept per thread, with no place of their own, and may only resolve", () => {
    const drafts = new ReviewDrafts(store);
    const reply = drafts.addReply({ pr: PR, headSha: "h1", threadId: "PRRT_aaa1111", body: "Fixed.", source: "you" });
    expect(reply).toMatchObject({ inReplyTo: "PRRT_aaa1111", resolve: false, body: "Fixed.", state: "draft" });
    expect(reply.path).toBeUndefined();
    expect(() =>
      drafts.addReply({ pr: PR, headSha: "h1", threadId: "PRRT_aaa1111", body: "Again", source: "you" }),
    ).toThrow(new RegExp(`already replying in that thread \\(${reply.id}\\)`));
    const resolveOnly = drafts.addReply({
      pr: PR,
      headSha: "h1",
      threadId: "PRRT_bbb2222",
      body: "  ",
      resolve: true,
      source: "you",
    });
    expect(resolveOnly).toMatchObject({ body: "", resolve: true });
    expect(() => drafts.addReply({ pr: PR, headSha: "h1", threadId: "PRRT_c", body: "", source: "you" })).toThrow(
      /needs some text, or Resolve ticked/,
    );
    // Unticking Resolve on a reply with no text leaves nothing to send.
    expect(() => drafts.editReply(resolveOnly.id, { resolve: false })).toThrow(/needs some text/);
    expect(drafts.editReply(resolveOnly.id, { body: "Thanks", resolve: false })).toMatchObject({
      body: "Thanks",
      resolve: false,
    });
    // The ordinary edit changes a reply's text, and never places it.
    expect(drafts.edit(reply.id, { body: "Fixed in 3f2c." })?.body).toBe("Fixed in 3f2c.");
    expect(() => drafts.edit(reply.id, { suggestion: "x" })).toThrow(/posts in its thread/);
    // The schema says the same.
    expect(ReviewDraftSchema.safeParse({ ...reply, path: "a.ts" }).success).toBe(false);
    expect(ReviewDraftSchema.safeParse({ ...reply, body: "", resolve: true }).success).toBe(true);
    expect(ReviewDraftSchema.safeParse({ ...reply, body: "", resolve: false }).success).toBe(false);
  });

  it("don't follow the diff, and aren't notes in the review body", () => {
    const drafts = new ReviewDrafts(store);
    const reply = drafts.addReply({ pr: PR, headSha: "h1", threadId: "PRRT_aaa1111", body: "Fixed.", source: "you" });
    const note = drafts.add({ pr: PR, headSha: "h1", body: "Overall fine.", source: "you" });
    expect(drafts.follow(PR, "h2", [V1])).toEqual({ moved: [], outdated: [] });
    expect(drafts.get(reply.id)).toMatchObject({ headSha: "h1", state: "draft" });
    expect(drafts.get(note.id)?.headSha).toBe("h2");
    expect(composeReviewBody("Body", drafts.list(PR))).toBe("Body\n\nOverall fine.");
  });
});

describe("finding a thread", () => {
  const threads = [
    thread("PRRT_kwDOAAA1111"),
    thread("PRRT_kwDOBBB2222", { line: null, originalLine: 9, isOutdated: true }),
    thread("PRRT_kwDOCCC3333", { path: "src/a.ts", line: 3, startLine: 1 }),
    thread("PRRT_kwDODDD4444", { isResolved: true }),
  ];
  it("by id, short id or file:line, preferring the open thread", () => {
    expect(shortThreadId("PRRT_kwDOAAA1111")).toBe("AAA1111");
    expect(findThread(threads, "PRRT_kwDOCCC3333").path).toBe("src/a.ts");
    expect(findThread(threads, "CCC3333").path).toBe("src/a.ts");
    expect(findThread(threads, "src/pay.ts:40").id).toBe("PRRT_kwDOAAA1111");
    expect(findThread(threads, "src/pay.ts:9").id).toBe("PRRT_kwDOBBB2222");
    expect(() => findThread(threads, "src/pay.ts:1")).toThrow(
      /No review thread src\/pay.ts:1.*AAA1111 \(src\/pay.ts:40\)/,
    );
    expect(() => findThread([thread("PRRT_x1"), thread("PRRT_x2")], "src/pay.ts:40")).toThrow(
      /2 threads are on src\/pay.ts:40/,
    );
    expect(() => findThread([], "x")).toThrow(/has no review threads/);
  });

  it("names where a thread is", () => {
    expect(threadWhere(threads[0] as ReviewThread)).toBe("src/pay.ts:40");
    expect(threadWhere(threads[1] as ReviewThread)).toBe("src/pay.ts:9");
    expect(threadWhere(threads[2] as ReviewThread)).toBe("src/a.ts:1-3");
    expect(threadWhere(thread("T", { line: null, originalLine: null }))).toBe("src/pay.ts");
  });

  it("checks you may reply and resolve there", () => {
    const all = { schemaVersion: 1 as const, pr: PR, headSha: "h1", viewer: "me", threads };
    expect(() => checkThread(all, "nope", { reply: true, resolve: false })).toThrow(/isn't on the PR any more/);
    const locked = { ...all, threads: [thread("T", { viewerCanReply: false, viewerCanResolve: false })] };
    expect(() => checkThread(locked, "T", { reply: true, resolve: false })).toThrow(/won't take your reply/);
    expect(() => checkThread(locked, "T", { reply: false, resolve: true })).toThrow(/won't let you resolve/);
    // Already resolved: nothing to ask of GitHub.
    const done = { ...all, threads: [thread("T", { isResolved: true, viewerCanResolve: false })] };
    expect(checkThread(done, "T", { reply: false, resolve: true }).id).toBe("T");
  });

  it("lets you reply in any thread you can see, and resolve only the ones you started", () => {
    const ana = {
      id: "C1",
      databaseId: 1,
      author: "ana",
      isYou: false,
      body: "Hm",
      createdAt: "2026-10-01T10:00:00.000Z",
      url: "u",
    };
    const theirs = thread("T", { startedByYou: false, comments: [ana] });
    const all = { schemaVersion: 1 as const, pr: PR, headSha: "h1", viewer: "me", threads: [theirs] };
    // GitHub would let you resolve it (viewerCanResolve), and you may reply: Alden still won't resolve Ana's thread.
    expect(checkThread(all, "T", { reply: true, resolve: false }).id).toBe("T");
    expect(() => checkThread(all, "T", { reply: true, resolve: true })).toThrow(
      "Alden resolves only threads you started, and @ana started the one on src/pay.ts:40: reply instead, and leave resolving it to them.",
    );
    const gone = { ...all, threads: [{ ...theirs, comments: [{ ...ana, author: null }] }] };
    expect(() => checkThread(gone, "T", { reply: false, resolve: true })).toThrow(/someone else started/);
    // Resolved already: nothing to refuse.
    const done = { ...all, threads: [{ ...theirs, isResolved: true }] };
    expect(checkThread(done, "T", { reply: false, resolve: true }).id).toBe("T");
  });
});

describe("sending replies", () => {
  it("keeps today's single request when there are no replies", async () => {
    new ReviewDrafts(store).add({ pr: PR, headSha: "h1", body: "Cents?", source: "you", place: placed() });
    const gh = fakeGitHub();
    const sent = await sendReview(gh.client, store, { repo: REPO, number: 7, event: "COMMENT" });
    expect(gh.order()).toEqual([POST]);
    expect(gh.calls[0]?.params.event).toBe("COMMENT");
    expect(sent).not.toHaveProperty("replies");
  });

  it("starts a pending review, replies into it, submits it, then resolves", async () => {
    const drafts = new ReviewDrafts(store);
    drafts.add({ pr: PR, headSha: "h1", body: "Cents?", source: "you", place: placed() });
    drafts.addReply({ pr: PR, headSha: "h1", threadId: "PRRT_1", body: "Fixed.", resolve: true, source: "you" });
    drafts.addReply({ pr: PR, headSha: "h1", threadId: "PRRT_2", body: "", resolve: true, source: "you" });
    const gh = fakeGitHub({ threads: [raw("PRRT_1"), raw("PRRT_2", { line: 9 })] });

    const sent = await sendReview(gh.client, store, { repo: REPO, number: 7, event: "APPROVE", body: "Nice" });
    expect(gh.order()).toEqual([POST, "reply", "submit", "resolve", "resolve"]);
    const [created, reply, submit, first, second] = gh.calls;
    // Pending: no verdict until every reply is in.
    expect(created?.params).not.toHaveProperty("event");
    expect(created?.params).toMatchObject({
      commit_id: "h1",
      body: "Nice",
      comments: [{ path: "src/pay.ts", line: 12, side: "RIGHT", body: "Cents?" }],
      request: { retries: 0 },
    });
    expect(reply?.params).toMatchObject({ review: "PRR_501", thread: "PRRT_1", body: "Fixed." });
    expect(submit?.params).toMatchObject({ review: "PRR_501", event: "APPROVE", body: "Nice" });
    expect([first?.params.thread, second?.params.thread]).toEqual(["PRRT_1", "PRRT_2"]);
    expect(sent).toMatchObject({
      url: "https://github.com/acme/shop/pull/7#r-501",
      posted: 2,
      replies: 1,
      resolved: 2,
      review: "APPROVE",
    });
    expect(sent.notResolved).toBeUndefined();
    expect(sent.counts).toMatchObject({ inline: 1, notes: 0, fromYou: 1 });
    // Only the line comment is watched for what comes of it: the replies aren't new line comments.
    expect(sentComments(store, REPO, 7)).toEqual([expect.objectContaining({ reviewId: 501, line: 12 })]);
    expect(drafts.list(PR)).toEqual([]);
  });

  it("sends a review of only replies as a comment", async () => {
    new ReviewDrafts(store).addReply({ pr: PR, headSha: "h1", threadId: "PRRT_1", body: "Done.", source: "you" });
    const gh = fakeGitHub({ threads: [raw("PRRT_1")] });
    const sent = await sendReview(gh.client, store, { repo: REPO, number: 7, event: "COMMENT" });
    expect(gh.order()).toEqual([POST, "reply", "submit"]);
    expect(gh.calls[0]?.params).toMatchObject({ comments: [] });
    expect(gh.calls[0]?.params).not.toHaveProperty("body");
    expect(sent).toMatchObject({ posted: 1, replies: 1, resolved: 0 });
  });

  it("leaves out Alden's drafts you haven't kept when replies send", async () => {
    const drafts = new ReviewDrafts(store);
    drafts.add({ pr: PR, headSha: "h1", body: "Alden's guess", source: "alden", place: placed() });
    drafts.addReply({ pr: PR, headSha: "h1", threadId: "PRRT_1", body: "Done.", source: "you" });
    const gh = fakeGitHub({ threads: [raw("PRRT_1")] });
    const sent = await sendReview(gh.client, store, { repo: REPO, number: 7, event: "COMMENT" });
    expect(gh.order()).toEqual([POST, "reply", "submit"]);
    expect(gh.calls[0]?.params).toMatchObject({ comments: [] });
    expect(sent).toMatchObject({ posted: 1, replies: 1 });
  });

  it("only resolves when there's nothing to post, and skips threads already resolved", async () => {
    const drafts = new ReviewDrafts(store);
    drafts.addReply({ pr: PR, headSha: "h1", threadId: "PRRT_1", body: "", resolve: true, source: "you" });
    drafts.addReply({ pr: PR, headSha: "h1", threadId: "PRRT_2", body: "", resolve: true, source: "you" });
    const gh = fakeGitHub({ threads: [raw("PRRT_1"), raw("PRRT_2", { isResolved: true })] });
    const sent = await sendReview(gh.client, store, { repo: REPO, number: 7, event: "COMMENT" });
    expect(gh.order()).toEqual(["resolve"]);
    expect(sent).toMatchObject({ url: "https://github.com/acme/shop/pull/7", posted: 0, resolved: 1 });
    expect(drafts.list(PR)).toEqual([]);
  });

  it("deletes the pending review when a reply fails, says which, and keeps every draft", async () => {
    const drafts = new ReviewDrafts(store);
    drafts.add({ pr: PR, headSha: "h1", body: "Cents?", source: "you", place: placed() });
    drafts.addReply({ pr: PR, headSha: "h1", threadId: "PRRT_1", body: "Fixed.", resolve: true, source: "you" });
    const gh = fakeGitHub({ threads: [raw("PRRT_1")], fail: { reply: "Thread is locked" } });
    const send = sendReview(gh.client, store, { repo: REPO, number: 7, event: "COMMENT" });
    await expect(send).rejects.toBeInstanceOf(SendReviewError);
    await expect(sendReview(gh.client, store, { repo: REPO, number: 7, event: "COMMENT" })).rejects.toThrow(
      /refused your reply in the thread on src\/pay.ts:40 \(GitHub said: Thread is locked\)\. Alden deleted the pending review/,
    );
    // Never submitted, never resolved.
    expect(gh.order()).not.toContain("submit");
    expect(gh.order()).not.toContain("resolve");
    expect(gh.order().slice(0, 3)).toEqual([POST, "reply", DELETE]);
    expect(gh.calls[2]?.params).toMatchObject({ review_id: 501 });
    expect(drafts.list(PR)).toHaveLength(2);
    expect(sentComments(store, REPO, 7)).toEqual([]);
  });

  it("deletes the pending review when submitting fails, and says if it couldn't", async () => {
    new ReviewDrafts(store).addReply({ pr: PR, headSha: "h1", threadId: "PRRT_1", body: "Fixed.", source: "you" });
    const failed = fakeGitHub({ threads: [raw("PRRT_1")], fail: { submit: "nope" } });
    await expect(sendReview(failed.client, store, { repo: REPO, number: 7, event: "COMMENT" })).rejects.toThrow(
      /refused submitting the review .*deleted the pending review/,
    );
    const stuck = fakeGitHub({ threads: [raw("PRRT_1")], fail: { submit: "nope", [DELETE]: "gone" } });
    await expect(sendReview(stuck.client, store, { repo: REPO, number: 7, event: "COMMENT" })).rejects.toThrow(
      /couldn't delete the pending review .* discard it on the PR's page/,
    );
  });

  it("reports a resolve that failed after the review posted", async () => {
    const drafts = new ReviewDrafts(store);
    drafts.addReply({ pr: PR, headSha: "h1", threadId: "PRRT_1", body: "Fixed.", resolve: true, source: "you" });
    const gh = fakeGitHub({ threads: [raw("PRRT_1")], fail: { resolve: "Not allowed" } });
    const sent = await sendReview(gh.client, store, { repo: REPO, number: 7, event: "COMMENT" });
    expect(sent).toMatchObject({ resolved: 0, notResolved: ["src/pay.ts:40: Not allowed"] });
    expect(drafts.list(PR)).toEqual([]);
  });

  it("refuses before posting anything when a thread is gone or not yours to resolve", async () => {
    const drafts = new ReviewDrafts(store);
    const a = drafts.addReply({ pr: PR, headSha: "h1", threadId: "PRRT_gone", body: "Hm", source: "you" });
    const b = drafts.addReply({ pr: PR, headSha: "h1", threadId: "PRRT_1", body: "", resolve: true, source: "you" });
    const gh = fakeGitHub({ threads: [raw("PRRT_1", { viewerCanResolve: false })] });
    await expect(sendReview(gh.client, store, { repo: REPO, number: 7, event: "COMMENT" })).rejects.toMatchObject({
      status: 422,
      reason: "thread",
      drafts: [a.id, b.id],
    });
    expect(gh.calls).toEqual([]);
  });
});
