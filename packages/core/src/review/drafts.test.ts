import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Briefing, LookHere } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiffFile } from "../diff/parse.js";
import { fromRestFile } from "../diff/sources.js";
import { FeedbackLog } from "../feedback/log.js";
import type { GitHubClient } from "../github/client.js";
import { loadLearning } from "../learn/learn.js";
import { AldenStore, MIGRATION_COUNT } from "../store/db.js";
import {
  checkLinkTarget,
  checkSendable,
  commentBody,
  composeReviewBody,
  findAgain,
  type Placement,
  placeOnDiff,
  placeOrLink,
  ReviewDrafts,
  reviewRequest,
  SendReviewError,
  sendReview,
  suggestionFence,
  unaddressedPlaces,
} from "./drafts.js";

const REPO = "acme/shop";
const PR = "acme/shop#7";

/** One file's diff as GitHub's files API returns it. */
const file = (filename: string, patch: string, extra: { previous_filename?: string; status?: string } = {}) =>
  fromRestFile({ filename, status: extra.status ?? "modified", additions: 1, deletions: 1, patch, ...extra });

const V1 = file(
  "src/pay.ts",
  [
    "@@ -10,6 +10,7 @@ export function pay()",
    " const a = 1;",
    " const b = 2;",
    "-const total = a + b;",
    "+const total = a + b + fee;",
    "+log(total);",
    " }",
    " ",
  ].join("\n"),
);
// Two lines added above the hunk: everything moves down by two.
const V2 = file(
  "src/pay.ts",
  [
    "@@ -10,6 +12,7 @@ export function pay()",
    " const a = 1;",
    " const b = 2;",
    "-const total = a + b;",
    "+const total = a + b + fee;",
    "+log(total);",
    " }",
    " ",
  ].join("\n"),
);
// The commented line itself changed.
const V3 = file(
  "src/pay.ts",
  [
    "@@ -10,6 +10,7 @@ export function pay()",
    " const a = 1;",
    " const b = 2;",
    "-const total = a + b;",
    "+const total = sum(a, b, fee);",
    "+log(total);",
    " }",
    " ",
  ].join("\n"),
);

/** A parsed file's patch again, as GitHub would send it. */
const patchOf = (f: DiffFile) =>
  f.hunks
    .map((h) =>
      [h.header, ...h.lines.map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`)].join("\n"),
    )
    .join("\n");

let home: string;
let store: AldenStore;
const savedHome = process.env.ALDEN_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "alden-drafts-"));
  // Sending reads learning.fromReviews from the user config: this one, never yours.
  process.env.ALDEN_HOME = home;
  store = AldenStore.open(join(home, "alden.db"));
});
afterEach(() => {
  store.close();
  if (savedHome === undefined) delete process.env.ALDEN_HOME;
  else process.env.ALDEN_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const placed = (files = [V1], line = 12, side: "RIGHT" | "LEFT" = "RIGHT") => {
  const p = placeOnDiff(files, "src/pay.ts", line, side);
  if ("problem" in p) throw new Error(p.problem);
  return p;
};

describe("placing a comment on the diff", () => {
  it("takes added and unchanged lines on the right, removed ones on the left, with the line's text", () => {
    expect(placed()).toEqual({
      path: "src/pay.ts",
      line: 12,
      side: "RIGHT",
      anchor: { text: "const total = a + b + fee;", before: "const b = 2;", after: "log(total);" },
      lines: ["const total = a + b + fee;"],
    });
    expect(placed([V1], 11).anchor.text).toBe("const b = 2;");
    expect(placed([V1], 12, "LEFT").anchor.text).toBe("const total = a + b;");
  });

  it("says why GitHub wouldn't take a comment elsewhere", () => {
    expect(placeOnDiff([V1], "src/other.ts", 3)).toEqual({
      problem: expect.stringMatching(/isn't changed in this PR/),
    });
    expect(placeOnDiff([V1], "src/pay.ts", 40)).toEqual({ problem: expect.stringMatching(/isn't in this PR's diff/) });
    expect(placeOnDiff([V1], "src/pay.ts", 15, "LEFT")).toEqual({ problem: expect.stringMatching(/on the old side/) });
    const big = fromRestFile({ filename: "big.json", status: "modified", additions: 9000, deletions: 0 });
    expect(placeOnDiff([big], "big.json", 1)).toEqual({ problem: expect.stringMatching(/general note/) });
  });
});

describe("finding a line again after a push", () => {
  it("follows the line when code above it moves it down", () => {
    expect(findAgain(placed(), [V2])).toMatchObject({ path: "src/pay.ts", line: 14, side: "RIGHT" });
  });

  it("gives up when the line itself changed", () => {
    expect(findAgain(placed(), [V3])).toBeUndefined();
  });

  it("follows a file that was renamed", () => {
    const renamed = file("src/payments.ts", patchOf(V2), {
      previous_filename: "src/pay.ts",
      status: "renamed",
    });
    expect(findAgain(placed(), [renamed])).toMatchObject({ path: "src/payments.ts", line: 14 });
  });

  it("won't guess between lines that look the same", () => {
    const twice = file("src/pay.ts", ["@@ -1,0 +1,5 @@", "+}", "+x();", "+}", "+y();", "+}"].join("\n"));
    const brace: Placement = { path: "src/pay.ts", line: 3, side: "RIGHT", anchor: { text: "}" } };
    expect(findAgain(brace, [twice])).toBeUndefined();
    // With its neighbours it's only itself.
    expect(findAgain({ ...brace, anchor: { text: "}", before: "x();", after: "y();" } }, [twice])?.line).toBe(3);
  });
});

describe("the drafts store", () => {
  it("adds, edits, lists and deletes drafts, oldest first", () => {
    const drafts = new ReviewDrafts(store);
    const a = drafts.add({ pr: PR, headSha: "h1", body: "Is fee in cents?", source: "you", place: placed() });
    const b = drafts.add({ pr: PR, headSha: "h1", body: "Looks good overall.", source: "claude" });
    expect(a).toMatchObject({ pr: PR, path: "src/pay.ts", line: 12, side: "RIGHT", state: "draft", source: "you" });
    expect(b.path).toBeUndefined();
    expect(drafts.edit(a.id, { body: "Is fee in cents, or dollars?" })?.body).toBe("Is fee in cents, or dollars?");
    expect(drafts.list("ACME/shop#7").map((d) => d.id)).toEqual([a.id, b.id]);
    expect(drafts.delete(b.id)?.source).toBe("claude");
    expect(drafts.list(PR)).toHaveLength(1);
    expect(() => drafts.add({ pr: PR, headSha: "h1", body: "  ", source: "you" })).toThrow(/needs some text/);
  });

  it("moves drafts with their lines when the PR moves, and marks the rest outdated", () => {
    const drafts = new ReviewDrafts(store);
    const moving = drafts.add({ pr: PR, headSha: "h1", body: "a", source: "you", place: placed() });
    const note = drafts.add({ pr: PR, headSha: "h1", body: "b", source: "you" });
    expect(drafts.follow(PR, "h2", [V2])).toEqual({ moved: [moving.id], outdated: [] });
    expect(drafts.get(moving.id)).toMatchObject({ line: 14, headSha: "h2", state: "draft" });
    expect(drafts.get(note.id)?.headSha).toBe("h2");

    expect(drafts.follow(PR, "h3", [V3])).toEqual({ moved: [], outdated: [moving.id] });
    // It keeps the place and head it was written for, so you can see what it was about.
    expect(drafts.get(moving.id)).toMatchObject({ line: 14, headSha: "h2", state: "outdated" });
    // Placed again, it's a draft again.
    const again = placeOnDiff([V3], "src/pay.ts", 14);
    if ("problem" in again) throw new Error(again.problem);
    expect(drafts.edit(moving.id, { place: { ...again, headSha: "h3" } })).toMatchObject({ state: "draft", line: 14 });
  });
});

// Two hunks: lines 10-15 and 41-43 of the new file.
const TWO_HUNKS = file(
  "src/pay.ts",
  [patchOf(V1), "@@ -40,2 +41,3 @@ export function refund()", " const r = 1;", "+audit(r);", " return r;"].join("\n"),
);
// A line inserted inside the range 11-13: its lines are all still there, but no longer together.
const V4 = file(
  "src/pay.ts",
  [
    "@@ -10,6 +10,8 @@ export function pay()",
    " const a = 1;",
    " const b = 2;",
    "+check(b);",
    "-const total = a + b;",
    "+const total = a + b + fee;",
    "+log(total);",
    " }",
    " ",
  ].join("\n"),
);

const range = (files = [V1], startLine = 11, line = 13) => {
  const p = placeOnDiff(files, "src/pay.ts", line, "RIGHT", startLine);
  if ("problem" in p) throw new Error(p.problem);
  return p;
};

describe("multi-line comments", () => {
  it("places a range within one hunk, with every line's text and the lines around it", () => {
    expect(range()).toEqual({
      path: "src/pay.ts",
      line: 13,
      side: "RIGHT",
      startLine: 11,
      anchor: { text: "log(total);", before: "const a = 1;", after: "}" },
      lines: ["const b = 2;", "const total = a + b + fee;", "log(total);"],
    });
    // A range of one line is just that line.
    expect(placeOnDiff([V1], "src/pay.ts", 12, "RIGHT", 12)).toEqual(placed());
  });

  it("says why GitHub wouldn't take a range", () => {
    expect(placeOnDiff([V1], "src/pay.ts", 11, "RIGHT", 13)).toEqual({
      problem: expect.stringMatching(/13 comes after 11/),
    });
    expect(placeOnDiff([V1], "src/pay.ts", 12, "RIGHT", 4)).toEqual({
      problem: expect.stringMatching(/^Line 4 of src\/pay.ts isn't in this PR's diff: every line of a multi-line/),
    });
    expect(placeOnDiff([V1], "src/pay.ts", 30, "RIGHT", 12)).toEqual({
      problem: expect.stringMatching(/^Line 30 /),
    });
    expect(placeOnDiff([TWO_HUNKS], "src/pay.ts", 42, "RIGHT", 13)).toEqual({
      problem: expect.stringMatching(
        /Lines 13-42 of src\/pay.ts span 2 hunks .* only takes a multi-line comment within one hunk/,
      ),
    });
    expect("problem" in placeOnDiff([TWO_HUNKS], "src/pay.ts", 43, "RIGHT", 41)).toBe(false);
  });

  it("follows a range only when all its lines are found together, unchanged", () => {
    expect(findAgain(range(), [V2])).toMatchObject({ line: 15, startLine: 13, lines: range().lines });
    // One of its lines changed.
    expect(findAgain(range(), [V3])).toBeUndefined();
    // A line landed in the middle of it.
    expect(findAgain(range(), [V4])).toBeUndefined();
  });

  it("is near a flagged place anywhere along its lines", () => {
    const drafts = new ReviewDrafts(store);
    const d = drafts.add({ pr: PR, headSha: "h1", body: "a", source: "you", place: range([TWO_HUNKS], 41, 43) });
    const at = (line: number): LookHere => ({ title: "t", reason: "r", anchor: { path: "src/pay.ts", line } });
    expect(unaddressedPlaces([at(37), at(38), at(46), at(47)], [d]).map((p) => p.line)).toEqual([37, 47]);
  });
});

describe("drafts written before 0.6", () => {
  it("are still read, sent and followed after the migration that adds ranges and suggestions", async () => {
    const path = join(home, "alden.db");
    store.close();
    // The drafts table as 0.5 left it, with one comment on a line.
    const { DatabaseSync } = await import("node:sqlite");
    const old = new DatabaseSync(path);
    old.exec("ALTER TABLE drafts DROP COLUMN start_line; ALTER TABLE drafts DROP COLUMN suggestion;");
    old.exec("ALTER TABLE drafts DROP COLUMN lines; ALTER TABLE drafts DROP COLUMN link_to; PRAGMA user_version = 3;");
    const { anchor } = placed();
    old
      .prepare(
        `INSERT INTO drafts (id, pr, pr_key, head_sha, path, line, side, anchor, body, source, state, created_at, updated_at)
         VALUES ('old1', ?, ?, 'h1', 'src/pay.ts', 12, 'RIGHT', ?, 'Cents?', 'you', 'draft', ?, ?)`,
      )
      .run(PR, PR.toLowerCase(), JSON.stringify(anchor), "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    old.close();
    store = AldenStore.open(path);
    expect(store.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(MIGRATION_COUNT);
    const drafts = new ReviewDrafts(store);
    const [draft] = drafts.list(PR);
    expect(draft).toMatchObject({ id: "old1", line: 12, body: "Cents?" });
    expect(draft).not.toHaveProperty("startLine");
    expect(draft).not.toHaveProperty("suggestion");
    expect(drafts.follow(PR, "h2", [V2])).toEqual({ moved: ["old1"], outdated: [] });
    expect(drafts.get("old1")).toMatchObject({ line: 14, originalLines: ["const total = a + b + fee;"] });
  });
});

describe("suggested changes", () => {
  it("fences the replacement so nothing in it can close the block", () => {
    expect(suggestionFence("const x = 1;")).toBe("```");
    expect(suggestionFence("const s = `a` + ``b``;")).toBe("```");
    expect(suggestionFence("/** ```ts\n * x\n * ``` */")).toBe("````");
    expect(suggestionFence("`````")).toBe("``````");
    expect(commentBody({ body: "Cents, please.", suggestion: "const total = cents(a + b);" })).toBe(
      "Cents, please.\n\n```suggestion\nconst total = cents(a + b);\n```",
    );
    expect(commentBody({ body: "", suggestion: "a\n```\nb" })).toBe("````suggestion\na\n```\nb\n````");
    // Empty: delete the lines.
    expect(commentBody({ body: "Not needed.\n", suggestion: "" })).toBe("Not needed.\n\n```suggestion\n```");
    expect(commentBody({ body: "Plain." })).toBe("Plain.");
  });

  it("stores a suggestion with the code it replaces, and only where GitHub can apply it", () => {
    const drafts = new ReviewDrafts(store);
    const d = drafts.add({ pr: PR, headSha: "h1", body: "", source: "you", place: range(), suggestion: "x();" });
    expect(drafts.get(d.id)).toMatchObject({
      startLine: 11,
      line: 13,
      body: "",
      suggestion: "x();",
      originalLines: ["const b = 2;", "const total = a + b + fee;", "log(total);"],
    });
    expect(() => drafts.add({ pr: PR, headSha: "h1", body: "", source: "you", suggestion: "x" })).toThrow(
      /not a general note/,
    );
    expect(() =>
      drafts.add({ pr: PR, headSha: "h1", body: "b", source: "you", place: placed([V1], 12, "LEFT"), suggestion: "x" }),
    ).toThrow(/new side \(RIGHT\)/);
    expect(() =>
      drafts.add({ pr: PR, headSha: "h1", body: "b", source: "you", place: placed(), suggestion: "x".repeat(70_000) }),
    ).toThrow(/with its suggestion; GitHub takes at most/);
    // Editing: the suggestion changes, and without it the comment needs text.
    expect(drafts.edit(d.id, { suggestion: "" })?.suggestion).toBe("");
    expect(() => drafts.edit(d.id, { suggestion: null })).toThrow(/needs some text/);
    expect(drafts.edit(d.id, { body: "Drop it", suggestion: null })).toMatchObject({ body: "Drop it" });
    expect(drafts.get(d.id)?.suggestion).toBeUndefined();
    const note = drafts.add({ pr: PR, headSha: "h1", body: "n", source: "you" });
    expect(() => drafts.edit(note.id, { suggestion: "x" })).toThrow(/not a general note/);
  });

  it("moves a suggestion only onto the same code, and is outdated otherwise", () => {
    const drafts = new ReviewDrafts(store);
    const d = drafts.add({ pr: PR, headSha: "h1", body: "", source: "you", place: range(), suggestion: "x();" });
    expect(drafts.follow(PR, "h2", [V2])).toEqual({ moved: [d.id], outdated: [] });
    expect(drafts.get(d.id)).toMatchObject({ startLine: 13, line: 15, headSha: "h2", state: "draft" });
    expect(drafts.follow(PR, "h4", [V4])).toEqual({ moved: [], outdated: [d.id] });
    // Placed again, it's against the code there now.
    const again = range([V4], 13, 14);
    expect(drafts.edit(d.id, { place: { ...again, headSha: "h4" } })).toMatchObject({
      state: "draft",
      startLine: 13,
      originalLines: ["const total = a + b + fee;", "log(total);"],
    });
  });

  it("refuses to send a suggestion whose code changed under it", () => {
    const drafts = new ReviewDrafts(store);
    const d = drafts.add({ pr: PR, headSha: "h1", body: "", source: "you", place: placed(), suggestion: "x();" });
    store.run("UPDATE drafts SET lines = ? WHERE id = ?", JSON.stringify(["something else"]), d.id);
    expect(() => checkSendable(drafts.list(PR), [V1], "COMMENT", undefined)).toThrow(
      /src\/pay.ts:12\) changed: place it again/,
    );
  });

  it("posts a range as start_line to line, with the suggestion block in its body", () => {
    const drafts = new ReviewDrafts(store);
    const d = drafts.add({
      pr: PR,
      headSha: "h1",
      body: "Simpler:",
      source: "you",
      place: range(),
      suggestion: "x();",
    });
    expect(reviewRequest("h1", "COMMENT", undefined, [d]).comments).toEqual([
      {
        path: "src/pay.ts",
        start_line: 11,
        start_side: "RIGHT",
        line: 13,
        side: "RIGHT",
        body: "Simpler:\n\n```suggestion\nx();\n```",
      },
    ]);
  });
});

const places: LookHere[] = [
  { title: "Money maths changed", reason: "r", anchor: { path: "src/pay.ts", line: 14 }, checkId: "paths.sensitive" },
  { title: "No tests", reason: "r", checkId: "tests.missing" },
  { title: "Model worry", reason: "r", anchor: { path: "src/other.ts", line: 3 }, source: "llm" },
];

describe("what a review covers", () => {
  it("lists flagged places no comment is near", () => {
    const drafts = new ReviewDrafts(store);
    const d = drafts.add({ pr: PR, headSha: "h1", body: "a", source: "you", place: placed() });
    expect(unaddressedPlaces(places, [d])).toEqual([
      { checkId: "tests.missing", title: "No tests" },
      { checkId: "model", title: "Model worry", path: "src/other.ts", line: 3 },
    ]);
  });

  it("posts exactly what you wrote: the body, then general notes, and each line comment", () => {
    const drafts = new ReviewDrafts(store);
    const inline = drafts.add({ pr: PR, headSha: "h1", body: "Cents?", source: "you", place: placed() });
    const note = drafts.add({ pr: PR, headSha: "h1", body: "Nice cleanup.", source: "claude" });
    expect(composeReviewBody(" Thanks! ", [inline, note])).toBe("Thanks!\n\nNice cleanup.");
    expect(reviewRequest("h1", "APPROVE", undefined, [inline, note])).toEqual({
      commit_id: "h1",
      event: "APPROVE",
      body: "Nice cleanup.",
      comments: [{ path: "src/pay.ts", line: 12, side: "RIGHT", body: "Cents?" }],
    });
  });
});

/** A fake GitHub: the PR's head and files, and what was posted. Nothing reaches GitHub. */
function fakeGitHub(state: { head: string; patch: DiffFile; fail?: { status: number; message: string } }) {
  const posted: Record<string, unknown>[] = [];
  const raw = (f: DiffFile) => ({
    filename: f.path,
    status: "modified",
    additions: f.additions,
    deletions: f.deletions,
    patch: patchOf(f),
  });
  const client = {
    request: async (route: string, params: Record<string, unknown>) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return { data: { head: { sha: state.head } } };
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
        return { data: params.page === 1 ? [raw(state.patch)] : [] };
      }
      if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
        if (state.fail) throw Object.assign(new Error(state.fail.message), { status: state.fail.status });
        posted.push(params);
        return { data: { html_url: "https://github.com/acme/shop/pull/7#pullrequestreview-1" } };
      }
      throw new Error(`unexpected ${route}`);
    },
  } as unknown as GitHubClient;
  return { client, posted };
}

const briefing = (at: string) =>
  ({ target: { kind: "pr", repo: REPO, number: 7 }, generatedAt: at, needsYourEyes: places }) as unknown as Briefing;

describe("sending a review", () => {
  it("posts one review at the head, records it, learns from it and clears the drafts", async () => {
    const drafts = new ReviewDrafts(store);
    drafts.rememberBriefing(briefing("2026-10-01T00:00:00.000Z"));
    drafts.add({ pr: PR, headSha: "h1", body: "Cents?", source: "you", place: placed() });
    drafts.add({ pr: PR, headSha: "h1", body: "From Claude.", source: "claude" });
    const gh = fakeGitHub({ head: "h1", patch: V1 });

    const result = await sendReview(gh.client, store, {
      repo: REPO,
      number: 7,
      event: "REQUEST_CHANGES",
      body: "Fix fees",
    });
    expect(result).toMatchObject({
      url: expect.stringContaining("pullrequestreview"),
      posted: 2,
      review: "REQUEST_CHANGES",
    });
    expect(result.counts).toEqual({
      inline: 1,
      notes: 1,
      fromYou: 1,
      fromClaude: 1,
      hasBody: true,
      suggestions: 0,
      linked: 0,
      unaddressed: 2,
      learned: 1,
      signals: {
        request_changes: 1,
        suggestion: 0,
        comment: 0,
        silent_pass: 0,
        miss: 0,
        applied: 0,
        resolved: 0,
      },
    });
    expect(gh.posted).toEqual([
      {
        owner: "acme",
        repo: "shop",
        pull_number: 7,
        commit_id: "h1",
        event: "REQUEST_CHANGES",
        body: "Fix fees\n\nFrom Claude.",
        comments: [{ path: "src/pay.ts", line: 12, side: "RIGHT", body: "Cents?" }],
        request: { retries: 0 },
      },
    ]);
    expect(drafts.list(PR)).toEqual([]);
    const sent = store.events<Record<string, unknown>>("review_sent");
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toMatch(/Cents|Claude\.|Fix fees/);

    // The comment near the flagged place, in a review requesting changes, is the strongest signal there is.
    const signals = new FeedbackLog(store).signals(REPO);
    expect(signals).toEqual([
      expect.objectContaining({
        type: "review_signal",
        pr: 7,
        signal: "request_changes",
        checkId: "paths.sensitive",
        path: "src/pay.ts",
        line: 14,
        weight: 2,
        source: "review",
      }),
    ]);
    expect(result.counts.signals).toMatchObject({ request_changes: 1, comment: 0, miss: 0 });
    expect(result.learning).toEqual([
      "2 of 3 (2 from your review of acme/shop#7): one more useful on sensitive-path flags and Alden will put them first among the places to look.",
    ]);
    // A second review of the same PR, saying less about the same place, adds nothing.
    drafts.add({ pr: PR, headSha: "h1", body: "Again", source: "you", place: placed() });
    const second = await sendReview(gh.client, store, { repo: REPO, number: 7, event: "COMMENT" });
    expect(second.counts.learned).toBe(0);
    expect(new FeedbackLog(store).signals(REPO)).toHaveLength(1);
    expect((await loadLearning(store, REPO)).checkTallies.get("paths.sensitive")).toMatchObject({
      agree: 2,
      notNeeded: 0,
      reviewAgree: 2,
    });
    // Nothing went to the old verdict log.
    expect(await new FeedbackLog(store).events(REPO)).toEqual([]);
  });

  it("counts a comment near a place from one of your notes toward the note, not a check", async () => {
    const drafts = new ReviewDrafts(store);
    const note = { id: "note:owners", text: "Every file needs a code owner header" };
    const noted = { title: "Missing code owner header", reason: "r", anchor: { path: "src/pay.ts", line: 12 } };
    drafts.rememberBriefing({
      target: { kind: "pr", repo: REPO, number: 7 },
      generatedAt: "2026-10-01T00:00:00.000Z",
      needsYourEyes: [{ ...noted, source: "llm", checkId: "tests.missing", fromNote: note }],
    } as unknown as Briefing);
    drafts.add({ pr: PR, headSha: "h1", body: "Header?", source: "you", place: placed() });
    const gh = fakeGitHub({ head: "h1", patch: V1 });
    expect((await sendReview(gh.client, store, { repo: REPO, number: 7, event: "COMMENT" })).counts.learned).toBe(1);
    expect((await new FeedbackLog(store).events(REPO))[0]).toMatchObject({
      verdict: "agree",
      via: "comment",
      item: { note: "note:owners" },
    });
    expect((await loadLearning(store, REPO)).checkTallies.size).toBe(0);
  });

  it("sends a suggestion like a comment, and learns from it the same way", async () => {
    const drafts = new ReviewDrafts(store);
    drafts.rememberBriefing(briefing("2026-10-01T00:00:00.000Z"));
    drafts.add({ pr: PR, headSha: "h1", body: "", source: "claude", place: range(), suggestion: "" });
    const gh = fakeGitHub({ head: "h1", patch: V1 });
    const result = await sendReview(gh.client, store, { repo: REPO, number: 7, event: "COMMENT" });
    expect(result.counts).toMatchObject({ inline: 1, suggestions: 1, learned: 1 });
    expect(new FeedbackLog(store).signals(REPO)).toEqual([
      expect.objectContaining({ signal: "suggestion", checkId: "paths.sensitive", weight: 2 }),
    ]);
    expect(gh.posted[0]?.comments).toEqual([
      {
        path: "src/pay.ts",
        start_line: 11,
        start_side: "RIGHT",
        line: 13,
        side: "RIGHT",
        body: "```suggestion\n```",
      },
    ]);
  });

  it("never overrides a verdict you gave the place yourself", async () => {
    const drafts = new ReviewDrafts(store);
    drafts.rememberBriefing(briefing("2026-10-01T00:00:00.000Z"));
    await new FeedbackLog(store).add({
      kind: "verdict",
      target: { kind: "pr", repo: REPO, number: 7 },
      briefingAt: "2026-10-01T00:00:00.000Z",
      item: {
        source: "check",
        checkId: "paths.sensitive",
        title: "Money maths changed",
        anchor: places[0]?.anchor,
        placement: "eyes",
      },
      verdict: "not_needed",
    });
    drafts.add({ pr: PR, headSha: "h1", body: "Cents?", source: "you", place: placed() });
    const result = await sendReview(fakeGitHub({ head: "h1", patch: V1 }).client, store, {
      repo: REPO,
      number: 7,
      event: "COMMENT",
    });
    expect(result.counts.learned).toBe(0);
  });

  it("refuses when the PR moved since you last looked, and when a draft is outdated", async () => {
    const drafts = new ReviewDrafts(store);
    const d = drafts.add({ pr: PR, headSha: "h1", body: "Cents?", source: "you", place: placed() });
    const gh = fakeGitHub({ head: "h3", patch: V3 });
    const moved = sendReview(gh.client, store, { repo: REPO, number: 7, event: "COMMENT" });
    await expect(moved).rejects.toMatchObject({ status: 409, reason: "moved", drafts: [d.id] });
    // Now it's outdated at the new head: still refused, naming it.
    const outdated = sendReview(gh.client, store, { repo: REPO, number: 7, event: "COMMENT" });
    await expect(outdated).rejects.toThrow(new RegExp(`${d.id} on src/pay.ts:12`));
    expect(gh.posted).toEqual([]);
  });

  it("refuses an empty review, and request-changes without a body", async () => {
    const gh = fakeGitHub({ head: "h1", patch: V1 });
    await expect(sendReview(gh.client, store, { repo: REPO, number: 7, event: "COMMENT" })).rejects.toMatchObject({
      reason: "empty",
    });
    new ReviewDrafts(store).add({ pr: PR, headSha: "h1", body: "Cents?", source: "you", place: placed() });
    await expect(
      sendReview(gh.client, store, { repo: REPO, number: 7, event: "REQUEST_CHANGES" }),
    ).rejects.toMatchObject({
      reason: "empty",
    });
    // Approving with nothing to say is fine.
    expect((await sendReview(gh.client, store, { repo: REPO, number: 7, event: "APPROVE" })).posted).toBe(1);
  });

  it("says what GitHub's refusals mean and keeps the drafts", async () => {
    const drafts = new ReviewDrafts(store);
    const d = drafts.add({ pr: PR, headSha: "h1", body: "Cents?", source: "you", place: placed() });
    const send = (fail: { status: number; message: string }) =>
      sendReview(fakeGitHub({ head: "h1", patch: V1, fail }).client, store, {
        repo: REPO,
        number: 7,
        event: "COMMENT",
      });
    await expect(send({ status: 403, message: "Resource not accessible by integration" })).rejects.toMatchObject({
      status: 403,
      reason: "forbidden",
      message: expect.stringMatching(/can't write reviews on acme\/shop/),
    });
    await expect(send({ status: 422, message: "Line could not be resolved" })).rejects.toMatchObject({
      status: 422,
      drafts: [d.id],
    });
    await expect(
      send({ status: 422, message: "User can only have one pending review per pull request" }),
    ).rejects.toMatchObject({
      reason: "pending",
    });
    await expect(send({ status: 500, message: "boom" })).rejects.toBeInstanceOf(SendReviewError);
    expect(drafts.list(PR)).toHaveLength(1);
  });
});

describe("linked notes", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  it("go inline when GitHub takes the line, and link to it when it won't", () => {
    expect(placeOrLink([V1], "src/pay.ts", 12)).toEqual({ place: placed() });
    expect(placeOrLink([V1], "py/orders/tasks.py", 5)).toEqual({ linkTo: { path: "py/orders/tasks.py", line: 5 } });
    expect(placeOrLink([V1], "src/pay.ts", 40)).toEqual({ linkTo: { path: "src/pay.ts", line: 40 } });
    expect(placeOrLink([V1], "src/pay.ts", 40, "RIGHT", 38)).toEqual({
      linkTo: { path: "src/pay.ts", line: 40, startLine: 38 },
    });
    // A range that leaves the diff halfway, a whole file, and a file too big to show: all links.
    expect(placeOrLink([V1], "src/pay.ts", 20, "RIGHT", 12)).toEqual({
      linkTo: { path: "src/pay.ts", line: 20, startLine: 12 },
    });
    expect(placeOrLink([V1], "src/pay.ts", undefined)).toEqual({ linkTo: { path: "src/pay.ts" } });
    const big = fromRestFile({ filename: "big.json", status: "modified", additions: 9000, deletions: 0 });
    expect(placeOrLink([big], "big.json", 1)).toEqual({ linkTo: { path: "big.json", line: 1 } });
    // What can't be linked stays a problem.
    expect(placeOrLink([V1], "src/pay.ts", 15, "LEFT")).toEqual({ problem: expect.stringMatching(/old side/) });
    expect(placeOrLink([V1], "src/pay.ts", 5, "RIGHT", 9)).toEqual({ problem: expect.stringMatching(/comes after/) });
    expect(placeOrLink([V1], "src/pay.ts", undefined, "RIGHT", 3)).toEqual({ problem: expect.any(String) });
  });

  it("post in the review body with a link to the line at the head they were written against", () => {
    const note = (linkTo: object | undefined, body: string, suggestion?: string) =>
      ({ pr: PR, headSha: SHA, body, linkTo, ...(suggestion !== undefined ? { suggestion } : {}) }) as never;
    const blob = `https://github.com/acme/shop/blob/${SHA}`;
    expect(composeReviewBody("Overall fine.", [note({ path: "py/orders/tasks.py", line: 5 }, "Retry here too?")])).toBe(
      `Overall fine.\n\n**[\`py/orders/tasks.py\` line 5](${blob}/py/orders/tasks.py#L5)**: Retry here too?`,
    );
    expect(composeReviewBody(undefined, [note({ path: "a b/c.py", line: 9, startLine: 4 }, "x")])).toBe(
      `**[\`a b/c.py\` lines 4–9](${blob}/a%20b/c.py#L4-L9)**: x`,
    );
    expect(composeReviewBody(undefined, [note({ path: "README.md" }, "Update this.")])).toBe(
      `**[\`README.md\`](${blob}/README.md)**: Update this.`,
    );
    // Text starting with a block goes on the next paragraph; the text itself is kept as written.
    expect(composeReviewBody(undefined, [note({ path: "a.py", line: 1 }, "- one\n- two")])).toBe(
      `**[\`a.py\` line 1](${blob}/a.py#L1)**\n\n- one\n- two`,
    );
    // A suggestion can't be applied from the body: it follows as code to copy.
    expect(composeReviewBody(undefined, [note({ path: "a.py", line: 1 }, "Use cents.", "total = cents(a)")])).toBe(
      `**[\`a.py\` line 1](${blob}/a.py#L1)**: Use cents.\n\nSuggested change:\n\n\`\`\`\ntotal = cents(a)\n\`\`\``,
    );
    expect(composeReviewBody(undefined, [note({ path: "a.py", line: 3, startLine: 1 }, "", "")])).toBe(
      `**[\`a.py\` lines 1–3](${blob}/a.py#L1-L3)**\n\nSuggested change: delete these lines.`,
    );
  });

  it("are stored with their link, stay at their head when the PR moves, and can be placed inline later", () => {
    const drafts = new ReviewDrafts(store);
    const d = drafts.add({
      pr: PR,
      headSha: "h1",
      body: "Same bug here?",
      source: "claude",
      linkTo: { path: "py/orders/tasks.py", line: 5 },
    });
    expect(drafts.get(d.id)).toMatchObject({ headSha: "h1", linkTo: { path: "py/orders/tasks.py", line: 5 } });
    expect(drafts.get(d.id)).not.toHaveProperty("path");
    expect(drafts.follow(PR, "h2", [V2])).toEqual({ moved: [], outdated: [] });
    expect(drafts.get(d.id)).toMatchObject({ headSha: "h1", state: "draft" });
    // Editing the text keeps the link.
    expect(drafts.edit(d.id, { body: "Same bug?" })).toMatchObject({ body: "Same bug?", linkTo: { line: 5 } });
    // Placed on a line of the diff, it's an inline comment; linked again, a note.
    const inline = drafts.edit(d.id, { place: { ...placed([V2], 14), headSha: "h2" } });
    expect(inline).toMatchObject({ path: "src/pay.ts", line: 14, headSha: "h2" });
    expect(inline).not.toHaveProperty("linkTo");
    const linked = drafts.edit(d.id, { linkTo: { path: "src/pay.ts", line: 40, headSha: "h3" } });
    expect(linked).toMatchObject({ headSha: "h3", linkTo: { path: "src/pay.ts", line: 40 } });
    expect(linked).not.toHaveProperty("line");
    expect(() =>
      drafts.add({ pr: PR, headSha: "h1", body: "x", source: "you", place: placed(), linkTo: { path: "a" } }),
    ).toThrow(/not both/);
  });

  it("keep a suggestion as code to copy, but only on lines", () => {
    const drafts = new ReviewDrafts(store);
    const d = drafts.add({
      pr: PR,
      headSha: "h1",
      body: "",
      source: "you",
      linkTo: { path: "a.py", line: 2 },
      suggestion: "x = 1",
    });
    expect(d).toMatchObject({ suggestion: "x = 1", linkTo: { line: 2 } });
    expect(() =>
      drafts.add({ pr: PR, headSha: "h1", body: "b", source: "you", linkTo: { path: "a.py" }, suggestion: "x" }),
    ).toThrow(/not a whole file/);
  });

  it("count as covering the flagged place they link to, and send with the review", async () => {
    const drafts = new ReviewDrafts(store);
    drafts.rememberBriefing(briefing("2026-10-01T00:00:00.000Z"));
    drafts.add({ pr: PR, headSha: "h1", body: "Same here?", source: "you", linkTo: { path: "src/other.ts", line: 4 } });
    drafts.add({ pr: PR, headSha: "h1", body: "Tests?", source: "you", linkTo: { path: "src/pay.ts", line: 40 } });
    expect(unaddressedPlaces(places, drafts.list(PR))).toEqual([
      { checkId: "paths.sensitive", title: "Money maths changed", path: "src/pay.ts", line: 14 },
      { checkId: "tests.missing", title: "No tests" },
    ]);
    // The PR moved on: the notes don't need placing again, and keep linking to the code you saw.
    const gh = fakeGitHub({ head: "h2", patch: V2 });
    const result = await sendReview(gh.client, store, { repo: REPO, number: 7, event: "COMMENT" });
    expect(result.counts).toMatchObject({ inline: 0, notes: 2, linked: 2, learned: 1 });
    expect(gh.posted[0]).toMatchObject({
      commit_id: "h2",
      body: [
        "**[`src/other.ts` line 4](https://github.com/acme/shop/blob/h1/src/other.ts#L4)**: Same here?",
        "**[`src/pay.ts` line 40](https://github.com/acme/shop/blob/h1/src/pay.ts#L40)**: Tests?",
      ].join("\n\n"),
      comments: [],
    });
  });

  it("check the file and line are there at the head before linking", async () => {
    const content = (text: string) => ({
      type: "file",
      encoding: "base64",
      content: Buffer.from(text).toString("base64"),
    });
    const github = (answer: () => unknown) =>
      ({
        request: async (route: string, params: Record<string, unknown>) => {
          expect(route).toBe("GET /repos/{owner}/{repo}/contents/{path}");
          expect(params).toMatchObject({ owner: "acme", repo: "shop", ref: SHA });
          return { data: answer() };
        },
      }) as unknown as GitHubClient;
    const fail = (status: number) => () => {
      throw Object.assign(new Error("no"), { status });
    };
    const check = (client: GitHubClient, link: { path: string; line?: number }) =>
      checkLinkTarget(client, REPO, SHA, link);
    expect(
      await check(
        github(() => content("a\nb\nc\n")),
        { path: "a.py", line: 3 },
      ),
    ).toBeUndefined();
    expect(
      await check(
        github(() => content("a\nb\nc\n")),
        { path: "a.py", line: 4 },
      ),
    ).toMatch(/a\.py has 3 lines at the PR's head \(0123456\), so there's no line 4/);
    expect(
      await check(
        github(() => content("a")),
        { path: "a.py" },
      ),
    ).toBeUndefined();
    expect(await check(github(fail(404)), { path: "nope.py", line: 1 })).toMatch(/nope\.py isn't in acme\/shop/);
    expect(
      await check(
        github(() => [{ name: "x" }]),
        { path: "py" },
      ),
    ).toMatch(/is a folder/);
    // A file too large for its content to come back, or GitHub not answering: kept as written.
    expect(
      await check(
        github(() => ({ type: "file", encoding: "none", content: "" })),
        { path: "big", line: 9 },
      ),
    ).toBeUndefined();
    expect(await check(github(fail(500)), { path: "a.py", line: 1 })).toBeUndefined();
  });
});
