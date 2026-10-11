import type { ReviewDraft } from "@alden/schema";
import { describe, expect, it } from "vitest";
import { draftedLines, parseWhere, renderDrafts, renderSendSummary, suggestionFrom } from "./comment.js";

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
    expect(parseWhere("src/pay.ts:12-14")).toEqual({ path: "src/pay.ts", startLine: 12, line: 14 });
    expect(parseWhere("src/pay.ts:12-12")).toEqual({ path: "src/pay.ts", line: 12 });
    // The wrong way round is kept, for the engine to say so.
    expect(parseWhere("src/pay.ts:14-12")).toEqual({ path: "src/pay.ts", startLine: 14, line: 12 });
    expect(parseWhere("src/pay.ts:12-0")).toBeUndefined();
    expect(parseWhere("src/pay.ts:12-")).toBeUndefined();
  });

  it("marks Alden's drafts you haven't kept, and says they won't be sent until you keep them", () => {
    const out = renderDrafts(
      "acme/shop#7",
      [
        draft({ id: "aa", path: "src/pay.ts", line: 2, source: "alden", drafted: { checkId: "model", title: "t" } }),
        draft({ id: "bb", path: "src/pay.ts", line: 9, source: "you", drafted: { checkId: "model", title: "u" } }),
      ],
      false,
    );
    expect(out).toContain("aa  src/pay.ts:2 · drafted by Alden, not kept");
    expect(out).toContain("bb  src/pay.ts:9\n");
    expect(out).toContain(
      "1 draft by Alden not kept won't be sent: keep it (alden comment acme/shop#7 --keep <id> or --keep all), or drop it with --delete <id>.",
    );
  });

  it("takes a suggestion as typed, from a file or from stdin, without the final newline of either", async () => {
    const read = { stdin: async () => "a();\nb();\n", file: async (path: string) => `// ${path}\r\n` };
    expect(await suggestionFrom({}, read)).toBeUndefined();
    expect(await suggestionFrom({ suggest: "x();\n" }, read)).toBe("x();\n");
    expect(await suggestionFrom({ suggest: "" }, read)).toBe("");
    expect(await suggestionFrom({ suggest: "-" }, read)).toBe("a();\nb();");
    expect(await suggestionFrom({ suggestFile: "fix.ts" }, read)).toBe("// fix.ts");
    await expect(suggestionFrom({ suggest: "x", suggestFile: "fix.ts" }, read)).rejects.toThrow(/not both/);
    const missing = { ...read, file: async () => Promise.reject(new Error("ENOENT")) };
    await expect(suggestionFrom({ suggestFile: "nope.ts" }, missing)).rejects.toThrow(/Couldn't read nope.ts: ENOENT/);
  });

  it("lists a range and a suggested change as the lines it replaces and the lines it suggests", () => {
    const out = renderDrafts(
      "acme/shop#7",
      [
        draft({
          path: "src/pay.ts",
          startLine: 12,
          line: 13,
          side: "RIGHT",
          body: "Use cents:",
          suggestion: "const total = cents(a + b);",
          originalLines: ["const total = a + b;", "log(total);"],
        }),
        draft({ id: "d2", path: "src/pay.ts", line: 20, body: "", suggestion: "", originalLines: ["debug();"] }),
      ],
      false,
    );
    expect(out).toContain(
      [
        "  a1b2c3d4  src/pay.ts:12-13",
        "    Use cents:",
        "    suggested change: replace these 2 lines",
        "    - const total = a + b;",
        "    - log(total);",
        "    + const total = cents(a + b);",
      ].join("\n"),
    );
    expect(out).toContain(
      ["  d2  src/pay.ts:20", "    suggested change: delete this line", "    - debug();", ""].join("\n"),
    );
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

  it("shows suggested changes as old lines and new ones", () => {
    const out = renderSendSummary(
      {
        pr: "acme/shop#7",
        event: "COMMENT",
        drafts: [
          draft({
            path: "src/pay.ts",
            line: 12,
            body: "",
            suggestion: "a();\nb();",
            originalLines: ["a()"],
            source: "claude",
          }),
        ],
        unaddressed: [],
      },
      false,
    );
    expect(out).toContain(
      [
        "Comments (1)",
        "  src/pay.ts:12 · drafted by Claude Code",
        "    suggested change: replace this line",
        "    - a()",
        "    + a();",
        "    + b();",
        "",
        "The suggested change posts as a GitHub suggestion: the author can apply it with a click.",
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

describe("linked notes in the terminal", () => {
  const note = {
    id: "n1",
    pr: "acme/shop#7",
    headSha: "0123456789abcdef",
    body: "Retry here too?",
    linkTo: { path: "py/orders/tasks.py", line: 5 },
    source: "you" as const,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    state: "draft" as const,
  };

  it("says a line outside the diff became a note linking to it", () => {
    expect(draftedLines(note, "acme/shop#7")).toEqual([
      "py/orders/tasks.py:5 isn't in the PR's diff, so this goes in the review body with a link to it, at the PR's head now (0123456).",
      "Drafted n1 (general note, linking to py/orders/tasks.py:5) for acme/shop#7. Nothing is posted until you send it:",
    ]);
    const suggested = { ...note, linkTo: { path: "a.py", line: 3, startLine: 1 }, suggestion: "x = 1" };
    expect(draftedLines(suggested, "acme/shop#7")[0]).toMatch(/^a.py:1-3 isn't .* it posts as code to copy\.$/);
  });

  it("lists it, and shows it in the body alden send posts", () => {
    expect(renderDrafts("acme/shop#7", [note], false)).toContain("n1  general note, linking to py/orders/tasks.py:5");
    const summary = renderSendSummary({ pr: "acme/shop#7", event: "COMMENT", drafts: [note], unaddressed: [] }, false);
    expect(summary).toContain(
      "**[`py/orders/tasks.py` line 5](https://github.com/acme/shop/blob/0123456789abcdef/py/orders/tasks.py#L5)**: Retry here too?",
    );
    expect(summary).toContain("Comments (0)");
  });
});
