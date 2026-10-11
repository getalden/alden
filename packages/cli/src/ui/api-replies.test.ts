import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A fake GitHub: one PR with two review threads, and every write recorded. Nothing reaches GitHub. */
const github = vi.hoisted(() => ({
  reads: 0,
  writes: [] as string[],
  canResolve: true,
}));

vi.mock("@alden/core", async (original) => ({
  ...(await original<typeof import("@alden/core")>()),
  resolveToken: async () => ({ token: "test-token", source: "env" }),
  createGitHubClient: () => ({
    request: async (route: string, params: Record<string, unknown>) => {
      if (route === "GET /user") return { data: { login: "me" } };
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return { data: { head: { sha: "h1" } } };
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
        const patch = ["@@ -1,2 +1,3 @@", " const a = 1;", "+const fee = 2;", " export { a };"].join("\n");
        return { data: params.page === 1 ? [{ filename: "src/pay.ts", status: "modified", patch }] : [] };
      }
      if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
        github.writes.push(`review ${"event" in params ? params.event : "pending"}`);
        return {
          data: { id: 9, node_id: "PRR_9", html_url: "https://github.com/acme/shop/pull/7#pullrequestreview-9" },
        };
      }
      throw new Error(`unexpected ${route}`);
    },
    graphql: async (query: string, params: Record<string, unknown>) => {
      if (query.includes("reviewThreads")) {
        github.reads++;
        const thread = (id: string, line: number, login: string) => ({
          id,
          path: "src/pay.ts",
          line,
          startLine: null,
          originalLine: line,
          diffSide: "RIGHT",
          isResolved: false,
          isOutdated: false,
          viewerCanReply: true,
          viewerCanResolve: github.canResolve,
          comments: {
            nodes: [
              {
                id: `C_${id}`,
                databaseId: 1,
                author: { login },
                body: "Cents?",
                createdAt: "2026-10-01T10:00:00Z",
                url: "https://github.com/acme/shop/pull/7#discussion_r1",
              },
            ],
          },
        });
        return {
          repository: {
            pullRequest: {
              headRefOid: "h1",
              reviewThreads: { nodes: [thread("PRRT_kwDOAAA1111", 2, "me"), thread("PRRT_kwDOBBB2222", 3, "ana")] },
            },
          },
        };
      }
      const name = /(addPullRequestReviewThreadReply|submitPullRequestReview|resolveReviewThread)/.exec(query)?.[1];
      github.writes.push(`${name} ${params.thread ?? params.event}`);
      return name === "submitPullRequestReview"
        ? { submitPullRequestReview: { pullRequestReview: { url: "https://github.com/acme/shop/pull/7#r-9" } } }
        : {};
    },
  }),
}));

const { closeStores } = await import("@alden/core");
const { createUiApi, THREADS_TTL_MS } = await import("./api.js");
const { aldenTools, INSTRUCTIONS } = await import("../mcp/tools.js");

let home: string;
const saved = { home: process.env.ALDEN_HOME, track: process.env.DO_NOT_TRACK };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "alden-api-replies-"));
  process.env.ALDEN_HOME = home;
  process.env.DO_NOT_TRACK = "1";
  github.reads = 0;
  github.writes = [];
  github.canResolve = true;
});
afterEach(() => {
  closeStores();
  vi.useRealTimers();
  if (saved.home === undefined) delete process.env.ALDEN_HOME;
  else process.env.ALDEN_HOME = saved.home;
  if (saved.track === undefined) delete process.env.DO_NOT_TRACK;
  rmSync(home, { recursive: true, force: true });
});

describe("threads and replies through the UI's API", () => {
  it("reads a PR's threads with yours marked, briefly cached", async () => {
    const api = createUiApi({ version: "test", cwd: home });
    const threads = await api.threads("https://github.com/acme/shop/pull/7");
    expect(threads).toMatchObject({ pr: "acme/shop#7", headSha: "h1", viewer: "me" });
    expect(threads.threads.map((t) => [t.id, t.startedByYou])).toEqual([
      ["PRRT_kwDOAAA1111", true],
      ["PRRT_kwDOBBB2222", false],
    ]);
    await api.threads("acme/shop#7");
    expect(github.reads).toBe(1);
    await api.threads("acme/shop#7", true);
    expect(github.reads).toBe(2);
    expect(THREADS_TTL_MS).toBeGreaterThan(0);
  });

  it("drafts a reply and a resolve, checks the thread, and sends them with the review", async () => {
    const api = createUiApi({ version: "test", cwd: home });
    const reply = await api.addDraft({ pr: "acme/shop#7", inReplyTo: "PRRT_kwDOBBB2222", body: "Yes, cents." });
    expect(reply).toMatchObject({ inReplyTo: "PRRT_kwDOBBB2222", resolve: false, headSha: "h1", source: "you" });
    expect(reply.path).toBeUndefined();
    const resolveOnly = await api.addDraft({
      pr: "acme/shop#7",
      inReplyTo: "PRRT_kwDOAAA1111",
      body: "",
      resolve: true,
    });
    expect(resolveOnly).toMatchObject({ body: "", resolve: true });
    expect((await api.editDraft(reply.id, { resolve: true })).resolve).toBe(true);
    await expect(api.editDraft(reply.id, { line: 2, path: "src/pay.ts" })).rejects.toMatchObject({ status: 400 });
    await expect(api.addDraft({ pr: "acme/shop#7", inReplyTo: "PRRT_nope", body: "Hm" })).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/isn't on the PR any more/),
    });
    await expect(
      api.addDraft({ pr: "acme/shop#7", inReplyTo: "PRRT_kwDOBBB2222", body: "Again" }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/already replying/) });
    await expect(
      api.addDraft({ pr: "acme/shop#7", inReplyTo: "PRRT_kwDOBBB2222", body: "x", path: "src/pay.ts", line: 2 }),
    ).rejects.toMatchObject({ status: 400 });
    // A comment isn't a reply: it can't resolve anything.
    const note = await api.addDraft({ pr: "acme/shop#7", body: "Overall fine." });
    await expect(api.editDraft(note.id, { resolve: true })).rejects.toMatchObject({ status: 400 });
    expect(github.writes).toEqual([]);

    const sent = await api.sendReview({ pr: "acme/shop#7", event: "COMMENT" });
    expect(sent).toEqual({
      url: "https://github.com/acme/shop/pull/7#r-9",
      posted: 2,
      review: "COMMENT",
      replies: 1,
      resolved: 2,
    });
    expect(github.writes).toEqual([
      "review pending",
      "addPullRequestReviewThreadReply PRRT_kwDOBBB2222",
      "submitPullRequestReview COMMENT",
      "resolveReviewThread PRRT_kwDOBBB2222",
      "resolveReviewThread PRRT_kwDOAAA1111",
    ]);
    expect((await api.drafts("acme/shop#7")).drafts).toEqual([]);
  });

  it("refuses to tick Resolve where GitHub won't let you", async () => {
    github.canResolve = false;
    const api = createUiApi({ version: "test", cwd: home });
    await expect(
      api.addDraft({ pr: "acme/shop#7", inReplyTo: "PRRT_kwDOBBB2222", body: "", resolve: true }),
    ).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/won't let you resolve/) });
    const reply = await api.addDraft({ pr: "acme/shop#7", inReplyTo: "PRRT_kwDOBBB2222", body: "Ok" });
    await expect(api.editDraft(reply.id, { resolve: true })).rejects.toMatchObject({ status: 422 });
  });
});

describe("Claude Code's replies", () => {
  it("drafts a reply by file:line through alden_draft_comment, and still can't send or resolve", async () => {
    const tools = aldenTools({ version: "test", cwd: home });
    expect(tools.map((t) => t.name).filter((n) => /send|post|approve|submit|resolve/.test(n))).toEqual([]);
    expect(INSTRUCTIONS).toMatch(/There is no tool to send, approve, request changes or resolve a thread/);
    const tool = tools.find((t) => t.name === "alden_draft_comment");
    expect(() =>
      tool?.input.parse({ pr: "acme/shop#7", in_reply_to: "src/pay.ts:3", path: "src/pay.ts", body: "x" }),
    ).toThrow(/leave out path/);
    const said = await tool?.call(tool.input.parse({ pr: "acme/shop#7", in_reply_to: "src/pay.ts:3", body: "Cents." }));
    expect(said).toMatch(/^Drafted \w+ as a reply in the thread on src\/pay.ts:3 for acme\/shop#7. Nothing is posted/);
    await expect(
      tool?.call(tool.input.parse({ pr: "acme/shop#7", in_reply_to: "src/pay.ts:9", body: "x" })),
    ).rejects.toThrow(/No review thread src\/pay.ts:9/);
    const { drafts } = await createUiApi({ version: "test", cwd: home }).drafts("acme/shop#7");
    expect(drafts).toEqual([
      expect.objectContaining({ source: "claude", inReplyTo: "PRRT_kwDOBBB2222", body: "Cents.", resolve: false }),
    ]);
    expect(github.writes).toEqual([]);
  });
});
