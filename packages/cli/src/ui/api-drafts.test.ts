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

describe("Claude Code's side", () => {
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
