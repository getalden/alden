import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Briefing } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A fake GitHub for the whole file: one PR with one changed file, and the repo's files. Nothing reaches GitHub. */
const github = vi.hoisted(() => ({
  head: "h1",
  posted: [] as Record<string, unknown>[],
  refuse: undefined as { status: number; message: string } | undefined,
  /** The repo's files at the head, for linked notes. */
  contents: {
    "src/pay.ts": "const a = 1;\nconst fee = 2;\nexport { a };\n",
    "py/orders/tasks.py": "import x\n\n\ndef run():\n    retry()\n",
  } as Record<string, string>,
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
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        const text = github.contents[params.path as string];
        if (text === undefined) throw Object.assign(new Error("Not Found"), { status: 404 });
        return { data: { type: "file", encoding: "base64", content: Buffer.from(text).toString("base64") } };
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
      message: expect.stringMatching(/src\/pay.ts has 3 lines at the PR's head \(h1\), so there's no line 9/),
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
      learning: [
        "1 of 3 (1 from your review of acme/shop#7): 2 more useful on sensitive-path flags and Alden will put them first among the places to look.",
      ],
    });
    expect(github.posted[0]).toMatchObject({
      commit_id: "h1",
      event: "COMMENT",
      body: "Two questions.\n\nConsider a test for the fee.",
      comments: [{ path: "src/pay.ts", line: 2, side: "RIGHT", body: "In cents?" }],
    });
    expect((await api.drafts("acme/shop#7")).drafts).toEqual([]);
  });

  it("counts approving past a place you saw as a silent pass, from the places the UI recorded", async () => {
    const { FeedbackLog } = await import("@alden/core");
    const api = createUiApi({ version: "test", cwd: home });
    new ReviewDrafts().rememberBriefing({
      target: { kind: "pr", repo: "acme/shop", number: 7 },
      generatedAt: "2026-10-01T00:00:00.000Z",
      needsYourEyes: [
        { title: "Fee added", reason: "r", checkId: "tests.missing", anchor: { path: "src/pay.ts", line: 2 } },
      ],
      checks: [{ id: "tests.missing", severity: "low" }],
    } as unknown as Briefing);
    await api.recordSeen({
      pr: "acme/shop#7",
      headSha: "h1",
      places: [{ checkId: "tests.missing", path: "src/pay.ts", line: 2, how: "guided" }],
    });
    await api.sendReview({ pr: "acme/shop#7", event: "APPROVE" });
    expect(new FeedbackLog().signals("acme/shop")).toEqual([
      expect.objectContaining({ signal: "silent_pass", checkId: "tests.missing", source: "review" }),
    ]);
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

describe("Alden's drafts through the UI's API", () => {
  /** One of Alden's drafts on src/pay.ts line 2, as a model briefing makes it. */
  async function aldenDraft() {
    const core = await import("@alden/core");
    const { files } = await core.fetchPullRequestState(core.createGitHubClient("t"), "acme/shop", 7);
    const briefing = {
      target: { kind: "pr", repo: "acme/shop", number: 7, headSha: "h1" },
      checks: [],
      llm: {
        status: "ok",
        findings: [
          {
            title: "Fee untested",
            checkId: "tests.missing",
            detail: "d",
            severity: "medium",
            anchors: [{ path: "src/pay.ts", line: 2 }],
            draft: { body: "Add a test for the fee." },
          },
        ],
      },
    } as unknown as Briefing;
    const [made] = core.makeAldenDrafts(briefing, files, { enabled: true }).made;
    if (!made) throw new Error("no draft made");
    return made;
  }

  it("keeps one, making it yours and sent with the review; an untouched one stays behind", async () => {
    const api = createUiApi({ version: "test", cwd: home });
    const draft = await aldenDraft();
    expect((await api.drafts("acme/shop#7")).drafts).toEqual([
      expect.objectContaining({
        id: draft.id,
        source: "alden",
        drafted: { checkId: "tests.missing", title: "Fee untested" },
      }),
    ]);
    // Sent untouched: it doesn't post.
    await api.sendReview({ pr: "acme/shop#7", event: "COMMENT", body: "Looks fine." });
    expect(github.posted[0]?.comments).toEqual([]);

    const again = await aldenDraft();
    expect(await api.keepDrafts({ pr: "acme/shop#7" })).toEqual({
      kept: [expect.objectContaining({ id: again.id, source: "you", drafted: again.drafted })],
    });
    await api.sendReview({ pr: "acme/shop#7", event: "COMMENT" });
    expect(github.posted[1]?.comments).toEqual([
      { path: "src/pay.ts", line: 2, side: "RIGHT", body: "Add a test for the fee." },
    ]);
  });

  it("makes an edited one yours, and drops one with the ordinary delete", async () => {
    const api = createUiApi({ version: "test", cwd: home });
    const edited = await api.editDraft((await aldenDraft()).id, { body: "Please add a test for the fee." });
    expect(edited).toMatchObject({
      source: "you",
      body: "Please add a test for the fee.",
      drafted: { title: "Fee untested" },
    });
    new ReviewDrafts().delete(edited.id);
    const dropped = await aldenDraft();
    expect(await api.deleteDraft(dropped.id)).toEqual({ ok: true });
    expect((await api.drafts("acme/shop#7")).drafts).toEqual([]);
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
    ).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/^src\/pay.ts has 3 lines/) });
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

describe("linked notes through the UI's API", () => {
  it("saves a comment outside the diff as a note linking to it, and sends it in the body", async () => {
    const api = createUiApi({ version: "test", cwd: home });
    const note = await api.addDraft({
      pr: "acme/shop#7",
      path: "py/orders/tasks.py",
      line: 5,
      body: "Retry here too?",
    });
    expect(note).toMatchObject({
      headSha: "h1",
      linkTo: { path: "py/orders/tasks.py", line: 5 },
      body: "Retry here too?",
    });
    expect(note).not.toHaveProperty("path");
    const file = await api.addDraft({ pr: "acme/shop#7", path: "src/pay.ts", body: "Split this file?" });
    expect(file.linkTo).toEqual({ path: "src/pay.ts" });
    await expect(api.addDraft({ pr: "acme/shop#7", path: "py/nope.py", line: 1, body: "x" })).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/py\/nope.py isn't in acme\/shop at the PR's head/),
    });
    // Placed on a line of the diff, it's an inline comment again.
    expect(await api.editDraft(file.id, { path: "src/pay.ts", line: 2 })).toMatchObject({
      path: "src/pay.ts",
      line: 2,
    });

    // A push: the inline comment follows its line (looked over in the drawer), the note keeps its link.
    github.head = "h2";
    expect((await api.drafts("acme/shop#7")).drafts.map((d) => d.headSha)).toEqual(["h1", "h2"]);
    await api.sendReview({ pr: "acme/shop#7", event: "COMMENT" });
    expect(github.posted[0]).toMatchObject({
      commit_id: "h2",
      body: "**[`py/orders/tasks.py` line 5](https://github.com/acme/shop/blob/h1/py/orders/tasks.py#L5)**: Retry here too?",
      comments: [{ path: "src/pay.ts", line: 2, body: "Split this file?" }],
    });
  });

  it("tells Claude when alden_draft_comment made a linked note", async () => {
    const tool = aldenTools({ version: "test", cwd: home }).find((t) => t.name === "alden_draft_comment");
    expect(tool?.description).toMatch(/linked note/);
    const said = await tool?.call(
      tool.input.parse({ pr: "acme/shop#7", path: "py/orders/tasks.py", start_line: 4, line: 5, body: "Same bug?" }),
    );
    expect(said).toMatch(
      /^py\/orders\/tasks.py:4-5 isn't in the PR's diff, so GitHub won't take an inline comment there. Drafted \w+ as a linked note instead: it goes in the review body, starting with a link to py\/orders\/tasks.py:4-5 at the PR's head \(h1\). Nothing is posted/,
    );
    const whole = await tool?.call(tool.input.parse({ pr: "acme/shop#7", path: "src/pay.ts", body: "Split it?" }));
    expect(whole).toMatch(/^GitHub's inline comments go on lines, not a whole file \(src\/pay.ts\)\. Drafted/);
    const suggested = await tool?.call(
      tool.input.parse({ pr: "acme/shop#7", path: "py/orders/tasks.py", line: 5, suggestion: "    retry(3)" }),
    );
    expect(suggested).toMatch(/posts as a code block for the author to copy/);
    const { drafts } = await createUiApi({ version: "test", cwd: home }).drafts("acme/shop#7");
    expect(drafts.map((d) => d.linkTo)).toEqual([
      { path: "py/orders/tasks.py", line: 5, startLine: 4 },
      { path: "src/pay.ts" },
      { path: "py/orders/tasks.py", line: 5 },
    ]);
    expect(github.posted).toEqual([]);
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
