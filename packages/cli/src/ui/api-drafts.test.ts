import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Briefing } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A fake GitHub for the whole file: one PR with one changed file. Nothing reaches GitHub. */
const github = vi.hoisted(() => ({
  head: "h1",
  posted: [] as Record<string, unknown>[],
  refuse: undefined as { status: number; message: string } | undefined,
}));

vi.mock("@alden/core", async (original) => ({
  ...(await original<typeof import("@alden/core")>()),
  resolveToken: async () => ({ token: "test-token", source: "env" }),
  createGitHubClient: () => ({
    request: async (route: string, params: Record<string, unknown>) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return { data: { head: { sha: github.head } } };
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
        const patch = ["@@ -1,2 +1,3 @@", " const a = 1;", "+const fee = 2;", " export { a };"].join("\n");
        return {
          data:
            params.page === 1
              ? [{ filename: "src/pay.ts", status: "modified", additions: 1, deletions: 0, patch }]
              : [],
        };
      }
      if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
        if (github.refuse) throw Object.assign(new Error(github.refuse.message), { status: github.refuse.status });
        github.posted.push(params);
        return { data: { html_url: "https://github.com/acme/shop/pull/7#pullrequestreview-9" } };
      }
      throw new Error(`unexpected ${route}`);
    },
  }),
}));

const { closeStores, ReviewDrafts } = await import("@alden/core");
const { createUiApi } = await import("./api.js");
const { aldenTools, INSTRUCTIONS } = await import("../mcp/tools.js");

let home: string;
const saved = { home: process.env.ALDEN_HOME, track: process.env.DO_NOT_TRACK };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "alden-api-drafts-"));
  process.env.ALDEN_HOME = home;
  process.env.DO_NOT_TRACK = "1";
  github.head = "h1";
  github.posted = [];
  github.refuse = undefined;
});
afterEach(() => {
  closeStores();
  if (saved.home === undefined) delete process.env.ALDEN_HOME;
  else process.env.ALDEN_HOME = saved.home;
  if (saved.track === undefined) delete process.env.DO_NOT_TRACK;
  rmSync(home, { recursive: true, force: true });
});

describe("drafts through the UI's API", () => {
  it("drafts at the PR's head, lists them with the flagged places they miss, and sends one review", async () => {
    const api = createUiApi({ version: "test", cwd: home });
    new ReviewDrafts().rememberBriefing({
      target: { kind: "pr", repo: "acme/shop", number: 7 },
      generatedAt: "2026-10-01T00:00:00.000Z",
      needsYourEyes: [
        { title: "Fee added", reason: "r", checkId: "paths.sensitive", anchor: { path: "src/pay.ts", line: 2 } },
        { title: "No tests", reason: "r", checkId: "tests.missing" },
      ],
    } as unknown as Briefing);

    const mine = await api.addDraft({
      pr: "https://github.com/acme/shop/pull/7",
      path: "src/pay.ts",
      line: 2,
      body: "Cents?",
    });
    expect(mine).toMatchObject({
      pr: "acme/shop#7",
      headSha: "h1",
      path: "src/pay.ts",
      line: 2,
      side: "RIGHT",
      source: "you",
    });
    expect(mine).not.toHaveProperty("anchor");
    const claude = await api.addDraft({ pr: "acme/shop#7", body: "Consider a test for the fee." }, "claude");
    expect(claude.source).toBe("claude");
    await expect(api.addDraft({ pr: "acme/shop#7", path: "src/pay.ts", line: 9, body: "x" })).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/isn't in this PR's diff/),
    });

    expect(await api.drafts("acme/shop#7")).toEqual({
      drafts: [mine, claude],
      unaddressed: [{ checkId: "tests.missing", title: "No tests" }],
    });
    expect((await api.editDraft(mine.id, { body: "In cents?" })).body).toBe("In cents?");

    const sent = await api.sendReview({ pr: "acme/shop#7", event: "COMMENT", body: "Two questions." });
    expect(sent).toEqual({
      url: "https://github.com/acme/shop/pull/7#pullrequestreview-9",
      posted: 2,
      review: "COMMENT",
    });
    expect(github.posted[0]).toMatchObject({
      commit_id: "h1",
      event: "COMMENT",
      body: "Two questions.\n\nConsider a test for the fee.",
      comments: [{ path: "src/pay.ts", line: 2, side: "RIGHT", body: "In cents?" }],
    });
    expect((await api.drafts("acme/shop#7")).drafts).toEqual([]);
  });

  it("says how to fix a sign-in that can't write reviews, and keeps the drafts", async () => {
    const api = createUiApi({ version: "test", cwd: home });
    await api.addDraft({ pr: "acme/shop#7", path: "src/pay.ts", line: 2, body: "Cents?" });
    github.refuse = { status: 403, message: "Resource not accessible by personal access token" };
    await expect(api.sendReview({ pr: "acme/shop#7", event: "COMMENT" })).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/can't write reviews on acme\/shop.*Pull requests: Read and write/),
    });
    expect((await api.drafts("acme/shop#7")).drafts).toHaveLength(1);
    await expect(api.deleteDraft("nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("suggested changes through the UI's API", () => {
  it("drafts a suggestion on a range, shows the code it replaces, and posts it as one", async () => {
    const api = createUiApi({ version: "test", cwd: home });
    const draft = await api.addDraft({
      pr: "acme/shop#7",
      path: "src/pay.ts",
      startLine: 1,
      line: 2,
      body: "",
      suggestion: "const a = 1;\nconst fee = cents(2);",
    });
    expect(draft).toMatchObject({
      startLine: 1,
      line: 2,
      side: "RIGHT",
      body: "",
      suggestion: "const a = 1;\nconst fee = cents(2);",
      originalLines: ["const a = 1;", "const fee = 2;"],
    });
    await expect(
      api.addDraft({ pr: "acme/shop#7", path: "src/pay.ts", startLine: 1, line: 9, body: "x" }),
    ).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/^Line 9 of src\/pay.ts isn't in/) });
    await expect(
      api.addDraft({ pr: "acme/shop#7", path: "src/pay.ts", line: 1, side: "LEFT", body: "x", suggestion: "y" }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/new side/) });
    await expect(api.addDraft({ pr: "acme/shop#7", body: "", suggestion: "y" })).rejects.toMatchObject({
      status: 400,
    });
    expect((await api.editDraft(draft.id, { suggestion: "" })).suggestion).toBe("");
    // Placed on one line again, it's against that line's code.
    expect(await api.editDraft(draft.id, { path: "src/pay.ts", line: 3 })).toMatchObject({
      line: 3,
      originalLines: ["export { a };"],
    });
    expect((await api.drafts("acme/shop#7")).drafts[0]).not.toHaveProperty("startLine");

    await api.editDraft(draft.id, { path: "src/pay.ts", startLine: 2, line: 3 });
    await api.sendReview({ pr: "acme/shop#7", event: "COMMENT" });
    expect(github.posted[0]?.comments).toEqual([
      {
        path: "src/pay.ts",
        start_line: 2,
        start_side: "RIGHT",
        line: 3,
        side: "RIGHT",
        body: "```suggestion\n```",
      },
    ]);
  });
});

describe("Claude Code's side", () => {
  it("drafts a suggested change through alden_draft_comment", async () => {
    const tools = aldenTools({ version: "test", cwd: home });
    const tool = tools.find((t) => t.name === "alden_draft_comment");
    expect(tool?.description).toMatch(/suggestion/);
    expect(() => tool?.input.parse({ pr: "acme/shop#7", path: "src/pay.ts", line: 2 })).toThrow(/body/);
    const said = await tool?.call(
      tool.input.parse({ pr: "acme/shop#7", path: "src/pay.ts", start_line: 1, line: 2, suggestion: "x();" }),
    );
    expect(said).toMatch(/^Drafted \w+ \(a suggested change\) on src\/pay.ts:1-2 for acme\/shop#7. Nothing is posted/);
    const { drafts } = await createUiApi({ version: "test", cwd: home }).drafts("acme/shop#7");
    expect(drafts).toEqual([
      expect.objectContaining({ source: "claude", body: "", suggestion: "x();", startLine: 1, line: 2 }),
    ]);
    expect(github.posted).toEqual([]);
  });

  it("drafts as Claude through alden_draft_comment, and has no way to send", async () => {
    const tools = aldenTools({ version: "test", cwd: home });
    expect(tools.map((t) => t.name).filter((n) => /send|post|approve|submit/.test(n))).toEqual([]);
    expect(INSTRUCTIONS).toContain("Alden posts only what the user sends from the UI or terminal");
    const tool = tools.find((t) => t.name === "alden_draft_comment");
    const said = await tool?.call(tool.input.parse({ pr: "acme/shop#7", path: "src/pay.ts", line: 2, body: "Cents?" }));
    expect(said).toMatch(/^Drafted \w+ on src\/pay.ts:2 for acme\/shop#7. Nothing is posted/);
    const { drafts } = await createUiApi({ version: "test", cwd: home }).drafts("acme/shop#7");
    expect(drafts).toEqual([expect.objectContaining({ source: "claude", body: "Cents?" })]);
    expect(github.posted).toEqual([]);
  });
});

describe("the Diff tab's diff", () => {
  it("serves a PR's diff at its head, from the cache until a push, and the local changes without a PR", async () => {
    const api = createUiApi({ version: "test", cwd: home });
    const first = await api.diff("acme/shop#7");
    expect(first.headSha).toBe("h1");
    expect(first.files[0]).toMatchObject({ path: "src/pay.ts", status: "modified", additions: 1 });
    expect(first.files[0]?.hunks[0]?.lines.map((l) => l.kind)).toEqual(["ctx", "add", "ctx"]);
    expect(await api.diff("https://github.com/acme/shop/pull/7")).toBe(first);
    github.head = "h2";
    expect((await api.diff("acme/shop#7")).headSha).toBe("h2");
    // The temporary ALDEN_HOME isn't a git repository.
    await expect(api.diff()).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/git repository/) });
    await expect(api.diff("not a pr")).rejects.toMatchObject({ status: 400 });
  });
});
