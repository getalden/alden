import type { ReviewDraft, ReviewThread } from "@alden/schema";
import { describe, expect, it } from "vitest";
import { renderDrafts, renderSendSummary, renderThreads, replyPlace, sentLines, sortThreads } from "./comment.js";

const draft = (extra: Partial<ReviewDraft>): ReviewDraft => ({
  id: "a1b2c3d4",
  pr: "acme/shop#7",
  headSha: "h1",
  body: "Fixed in 3f2c.",
  source: "you",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  state: "draft",
  ...extra,
});

const comment = (author: string, body: string, isYou = false) => ({
  id: `C_${author}`,
  databaseId: 1,
  author,
  isYou,
  body,
  createdAt: "2026-10-01T10:00:00.000Z",
  url: "https://github.com/acme/shop/pull/7#discussion_r1",
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
  startedByYou: false,
  viewerCanReply: true,
  viewerCanResolve: true,
  comments: [comment("ana", "Cents?")],
  ...extra,
});

describe("alden comment --threads and --reply", () => {
  it("lists threads yours first, open first, with short ids and every comment", () => {
    const threads = [
      thread("PRRT_kwDOAAA1111", { path: "src/a.ts", line: 3 }),
      thread("PRRT_kwDOBBB2222", { isResolved: true, startedByYou: true, comments: [comment("me", "Typo", true)] }),
      thread("PRRT_kwDOCCC3333", {
        startedByYou: true,
        comments: [comment("me", "Cents?", true), comment("ana", "Yes")],
      }),
    ];
    expect(sortThreads(threads).map((t) => t.id.slice(-7))).toEqual(["CCC3333", "BBB2222", "AAA1111"]);
    const out = renderThreads("acme/shop#7", threads, false);
    expect(out).toContain("acme/shop#7: 3 review threads, 2 open");
    expect(out).toContain("  CCC3333  src/pay.ts:40  open · started by you\n    you\n      Cents?\n    ana\n      Yes");
    expect(out).toContain("  BBB2222  src/pay.ts:40  resolved · started by you");
    expect(out).toContain('alden comment acme/shop#7 --reply <id or file:line> "Your reply" [--resolve]');
    expect(renderThreads("acme/shop#7", [], false)).toBe("acme/shop#7 has no review threads yet.\n");
    // Comments are other people's text: escape codes never reach the terminal.
    expect(renderThreads("p", [thread("T1234567", { comments: [comment("x", "\u001b[2Jhi")] })], false)).not.toContain(
      "\u001b",
    );
  });

  it("says where each reply goes, and that it resolves", () => {
    const threads = [thread("PRRT_kwDOAAA1111")];
    expect(replyPlace(draft({ inReplyTo: "PRRT_kwDOAAA1111", resolve: false }), threads)).toBe(
      "reply in thread on src/pay.ts:40",
    );
    expect(replyPlace(draft({ inReplyTo: "PRRT_kwDOAAA1111", resolve: true }), threads)).toBe(
      "reply in thread on src/pay.ts:40, and resolve it",
    );
    expect(replyPlace(draft({ inReplyTo: "PRRT_kwDOAAA1111", body: "", resolve: true }), threads)).toBe(
      "resolve the thread on src/pay.ts:40",
    );
    // Without GitHub, by its short id.
    expect(replyPlace(draft({ inReplyTo: "PRRT_kwDOAAA1111" }))).toBe("reply in thread AAA1111");
    expect(
      renderDrafts("acme/shop#7", [draft({ inReplyTo: "PRRT_kwDOAAA1111", resolve: true })], false, threads),
    ).toContain("a1b2c3d4  reply in thread on src/pay.ts:40, and resolve it");
  });

  it("shows replies in the send summary, apart from the body, and what was sent", () => {
    const out = renderSendSummary(
      {
        pr: "acme/shop#7",
        event: "COMMENT",
        drafts: [
          draft({ id: "n1", body: "Overall fine." }),
          draft({ id: "r1", inReplyTo: "PRRT_kwDOAAA1111", resolve: true }),
          draft({ id: "r2", inReplyTo: "PRRT_kwDOBBB2222", body: "", resolve: true }),
        ],
        unaddressed: [],
        threads: [thread("PRRT_kwDOAAA1111"), thread("PRRT_kwDOBBB2222", { path: "src/a.ts", line: 3 })],
      },
      false,
    );
    expect(out).toContain("Body\n  Overall fine.\n");
    expect(out).not.toMatch(/Body\n[^\n]*\n[^\n]*Fixed in 3f2c/);
    expect(out).toContain(
      "Replies in threads (2)\n  Reply in thread on src/pay.ts:40, and resolve it\n    Fixed in 3f2c.",
    );
    expect(out).toContain("  Resolve the thread on src/a.ts:3");
    expect(out).toContain("resolved after the review is submitted, never before");
    expect(
      sentLines(
        { url: "u", posted: 3, review: "COMMENT", replies: 1, resolved: 1, notResolved: ["src/a.ts:3: Not allowed"] },
        false,
      ),
    ).toEqual([
      "Sent: u (2 comments, 1 reply; 1 thread resolved).",
      "Not resolved (the review did post): src/a.ts:3: Not allowed",
    ]);
    expect(sentLines({ url: "u", posted: 1, review: "APPROVE" }, false)).toEqual(["Sent: u (1 comment)."]);
    expect(sentLines({ url: "u", posted: 0, review: "COMMENT", replies: 0, resolved: 2 }, false)).toEqual([
      "Sent: u (2 threads resolved).",
    ]);
  });
});
