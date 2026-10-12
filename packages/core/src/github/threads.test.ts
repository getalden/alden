import { describe, expect, it } from "vitest";
import type { GitHubClient } from "./client.js";
import { fetchReviewThreads, type RawThread, repliedToYou, toReviewThreads, yourThreads } from "./threads.js";

const comment = (login: string | null, at: string, body = "text") => ({
  id: `C_${login}_${at}`,
  databaseId: 1,
  author: login === null ? null : { login },
  body,
  createdAt: at,
  url: "https://github.com/acme/shop/pull/1#discussion_r1",
});

const thread = (id: string, comments: ReturnType<typeof comment>[], extra: Partial<RawThread> = {}): RawThread => ({
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
  comments: { nodes: comments },
  ...extra,
});

describe("toReviewThreads", () => {
  it("orders comments, marks yours and who started the thread", () => {
    const out = toReviewThreads("acme/shop", 1, "Me", {
      headRefOid: "abc",
      reviewThreads: {
        nodes: [
          thread("T1", [comment("ana", "2026-10-02T10:00:00Z"), comment("me", "2026-10-01T10:00:00Z")]),
          thread("T2", [comment("ana", "2026-10-01T10:00:00Z")], { isResolved: true }),
          null,
          thread("T3", []),
        ],
      },
    });
    expect(out.pr).toBe("acme/shop#1");
    expect(out.threads.map((t) => t.id)).toEqual(["T1", "T2"]);
    expect(out.threads[0]?.startedByYou).toBe(true);
    expect(out.threads[0]?.comments.map((c) => c.isYou)).toEqual([true, false]);
    expect(out.threads[1]?.startedByYou).toBe(false);
  });

  it("finds threads someone answered after you", () => {
    const { threads } = toReviewThreads("acme/shop", 1, "me", {
      headRefOid: "abc",
      reviewThreads: {
        nodes: [
          thread("T1", [comment("me", "2026-10-01T10:00:00Z"), comment("ana", "2026-10-02T10:00:00Z")]),
          thread("T2", [comment("me", "2026-10-01T10:00:00Z")]),
          thread("T3", [comment("ana", "2026-10-01T10:00:00Z"), comment("bo", "2026-10-02T10:00:00Z")]),
        ],
      },
    });
    expect(yourThreads(threads).map((t) => t.id)).toEqual(["T1", "T2"]);
    expect(threads.filter(repliedToYou).map((t) => t.id)).toEqual(["T1"]);
  });

  it("says when you resolved a thread yourself", () => {
    const { threads } = toReviewThreads("acme/shop", 1, "Me", {
      headRefOid: "abc",
      reviewThreads: {
        nodes: [
          thread("T1", [comment("me", "2026-10-01T10:00:00Z")], { isResolved: true, resolvedBy: { login: "me" } }),
          thread("T2", [comment("me", "2026-10-01T10:00:00Z")], { isResolved: true, resolvedBy: { login: "ana" } }),
          thread("T3", [comment("me", "2026-10-01T10:00:00Z")], { isResolved: true, resolvedBy: null }),
        ],
      },
    });
    expect(threads.map((t) => t.resolvedByYou)).toEqual([true, undefined, undefined]);
  });
});

describe("fetchReviewThreads", () => {
  it("says nothing for a PR that's gone", async () => {
    const client = {
      graphql: async () => {
        throw Object.assign(new Error("gone"), { errors: [{ type: "NOT_FOUND" }] });
      },
    } as unknown as GitHubClient;
    expect(await fetchReviewThreads(client, "acme/shop", 1, "me")).toBeUndefined();
  });
});
