import type { ReviewDraft } from "@alden/schema";
import { describe, expect, it } from "vitest";
import { parseWhere, renderDrafts, renderSendSummary } from "./comment.js";

const draft = (extra: Partial<ReviewDraft>): ReviewDraft => ({
  id: "a1b2c3d4",
  pr: "acme/shop#7",
  headSha: "h1",
  body: "Is this in cents?",
  source: "you",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  state: "draft",
  ...extra,
});

describe("alden comment", () => {
  it("reads file:line, and nothing else, as a place", () => {
    expect(parseWhere("src/pay.ts:12")).toEqual({ path: "src/pay.ts", line: 12 });
    expect(parseWhere("looks")).toBeUndefined();
    expect(parseWhere("src/pay.ts:0")).toBeUndefined();
    expect(parseWhere("fix this:2 now")).toBeUndefined();
  });

  it("lists comments with their places, who drafted them, and which are outdated", () => {
    const out = renderDrafts(
      "acme/shop#7",
      [
        draft({ path: "src/pay.ts", line: 12, side: "RIGHT" }),
        draft({ id: "e5f6", body: "Nice\u001b[31m work", source: "claude" }),
        draft({ id: "9c0d", path: "src/old.ts", line: 3, side: "LEFT", state: "outdated" }),
      ],
      false,
    );
    expect(out).toContain("acme/shop#7: 3 comments waiting to be sent");
    expect(out).toContain("a1b2c3d4  src/pay.ts:12\n    Is this in cents?");
    expect(out).toContain("e5f6  general note · drafted by Claude Code\n    Nice work");
    expect(out).not.toContain("\u001b");
    expect(out).toContain("9c0d  src/old.ts:3 (old side)\n    outdated:");
    expect(out).toContain("alden comment acme/shop#7 --delete <id>");
    expect(renderDrafts("acme/shop#7", [], false)).toMatch(/^No comments waiting for acme\/shop#7/);
  });
});

describe("alden send's summary", () => {
  const drafts = [
    draft({ path: "src/pay.ts", line: 12, side: "RIGHT" }),
    draft({ id: "n1", body: "Add a test?", source: "claude" }),
  ];
  const unaddressed = [
    { checkId: "tests.missing", title: "No tests" },
    { checkId: "paths.sensitive", title: "Fee", path: "src/pay.ts", line: 40 },
  ];

  it("shows exactly what will post: the body with notes after it, each comment, and who drafted what", () => {
    const out = renderSendSummary({ pr: "acme/shop#7", event: "COMMENT", body: "Thanks!", drafts, unaddressed }, false);
    expect(out).toBe(
      [
        "Review for acme/shop#7: Comment",
        "",
        "Body",
        "  Thanks!",
        "",
        "  Add a test?",
        "",
        "Comments (1)",
        "  src/pay.ts:12",
        "    Is this in cents?",
        "",
        "1 of these was drafted by Claude Code: they post as you.",
        "",
      ].join("\n"),
    );
  });

  it("before approving, lists the flagged places you didn't comment on", () => {
    const out = renderSendSummary({ pr: "acme/shop#7", event: "APPROVE", drafts: [], unaddressed }, false);
    expect(out).toContain("Review for acme/shop#7: Approve");
    expect(out).toContain("Body\n  (none)");
    expect(out).toContain("Places Alden flagged that you didn't comment on\n  ! No tests\n  ! Fee (src/pay.ts:40)");
  });
});
