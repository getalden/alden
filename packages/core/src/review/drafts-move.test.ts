import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiffFile } from "../diff/parse.js";
import { fromRestFile } from "../diff/sources.js";
import type { GitHubClient } from "../github/client.js";
import { AldenStore } from "../store/db.js";
import {
  draftsAtHead,
  lineLikeness,
  moveCandidate,
  type Placement,
  placeOnDiff,
  ReviewDrafts,
  sendReview,
} from "./drafts.js";

/*
 * "Move to new lines": where an outdated draft's code went at the PR's head, offered (never applied) in the drawer.
 */

const REPO = "acme/shop";
const PR = "acme/shop#7";

const file = (filename: string, lines: string[]) =>
  fromRestFile({ filename, status: "modified", additions: 1, deletions: 1, patch: lines.join("\n") });

const V1 = file("src/pay.ts", [
  "@@ -10,6 +10,7 @@ export function pay()",
  " const a = 1;",
  " const b = 2;",
  "-const total = a + b;",
  "+const total = a + b + fee;",
  "+log(total);",
  " }",
  " ",
]);
// The commented line itself changed, a little, and moved down two lines.
const V3 = file("src/pay.ts", [
  "@@ -10,6 +12,7 @@ export function pay()",
  " const a = 1;",
  " const b = 2;",
  "-const total = a + b;",
  "+const total = a + b + fees;",
  "+log(total);",
  " }",
  " ",
]);
// Rewritten past recognising.
const V4 = file("src/pay.ts", [
  "@@ -10,4 +10,4 @@ export function pay()",
  " const a = 1;",
  "-const b = 2;",
  "+return charge(a);",
  " }",
]);

const placed = (files: DiffFile[] = [V1], line = 12, startLine?: number): Placement => {
  const p = placeOnDiff(files, "src/pay.ts", line, "RIGHT", startLine);
  if ("problem" in p) throw new Error(p.problem);
  return p;
};

describe("where an outdated draft's code went", () => {
  it("reads lines alike by their characters, ignoring spacing", () => {
    expect(lineLikeness("const  total = a;", "const total = a;")).toBe(1);
    expect(lineLikeness("const total = a + b + fee;", "const total = a + b + fees;")).toBeGreaterThan(0.9);
    expect(lineLikeness("const total = a + b + fee;", "return charge(a);")).toBeLessThan(0.5);
  });

  it("offers the line that reads most like it, where its neighbours still are", () => {
    expect(moveCandidate(placed(), [V3])).toEqual({ path: "src/pay.ts", line: 14, side: "RIGHT" });
  });

  it("keeps a range's length within the hunk it lands in", () => {
    expect(moveCandidate(placed([V1], 13, 12), [V3])).toEqual({
      path: "src/pay.ts",
      line: 15,
      startLine: 14,
      side: "RIGHT",
    });
  });

  it("offers nothing when the code was rewritten, or the file left the PR", () => {
    expect(moveCandidate(placed(), [V4])).toBeUndefined();
    expect(moveCandidate(placed(), [file("src/other.ts", ["@@ -1,1 +1,1 @@", "-a", "+b"])])).toBeUndefined();
  });

  it("won't choose between two places that are equally close: you pick a line", () => {
    const twice = file("src/pay.ts", ["@@ -1,0 +1,5 @@", "+log(total1);", "+x();", "+y();", "+z();", "+log(total2);"]);
    const at3: Placement = { path: "src/pay.ts", line: 3, side: "RIGHT", anchor: { text: "log(total);" } };
    expect(moveCandidate(at3, [twice])).toBeUndefined();
    // Nearer one place than the other, it's that one.
    expect(moveCandidate({ ...at3, line: 2 }, [twice])?.line).toBe(1);
  });

  it("matches a blank line or a lone brace only by what's around it", () => {
    const brace: Placement = { path: "src/pay.ts", line: 3, side: "RIGHT", anchor: { text: "}" } };
    const code = file("src/pay.ts", ["@@ -1,0 +1,3 @@", "+x();", "+}", "+y();"]);
    expect(moveCandidate(brace, [code])).toBeUndefined();
    expect(moveCandidate({ ...brace, anchor: { text: "}", before: "x();" } }, [code])?.line).toBe(2);
  });
});

let home: string;
let store: AldenStore;
const savedHome = process.env.ALDEN_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "alden-move-"));
  process.env.ALDEN_HOME = home;
  store = AldenStore.open(join(home, "alden.db"));
});
afterEach(() => {
  store.close();
  if (savedHome === undefined) delete process.env.ALDEN_HOME;
  else process.env.ALDEN_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const patchOf = (f: DiffFile) =>
  f.hunks
    .map((h) =>
      [h.header, ...h.lines.map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`)].join("\n"),
    )
    .join("\n");

/** A fake GitHub: the PR's head and files, and what was posted. Nothing reaches GitHub. */
function fakeGitHub(state: { head: string; patch: DiffFile }) {
  const posted: Record<string, unknown>[] = [];
  const client = {
    request: async (route: string, params: Record<string, unknown>) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return { data: { head: { sha: state.head } } };
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
        const f = state.patch;
        return {
          data:
            params.page === 1
              ? [{ filename: f.path, status: "modified", additions: 1, deletions: 1, patch: patchOf(f) }]
              : [],
        };
      }
      if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
        posted.push(params);
        return { data: { id: 501, html_url: "https://github.com/acme/shop/pull/7#pullrequestreview-1" } };
      }
      throw new Error(`unexpected ${route}`);
    },
  } as unknown as GitHubClient;
  return { client, posted };
}

describe("outdated drafts as the UI lists them", () => {
  it("says the head their lines changed at and where the code is now; moving one there makes it a draft again", () => {
    const drafts = new ReviewDrafts(store);
    const d = drafts.add({ pr: PR, headSha: "h1", body: "Fees in cents?", source: "you", place: placed() });
    const note = drafts.add({ pr: PR, headSha: "h1", body: "Thanks!", source: "you" });
    expect(drafts.follow(PR, "h3", [V3]).outdated).toEqual([d.id]);
    const [listed, plain] = draftsAtHead(drafts.list(PR), "h3", [V3]);
    expect(listed).toMatchObject({
      id: d.id,
      state: "outdated",
      changedIn: "h3",
      movedTo: { path: "src/pay.ts", line: 14, side: "RIGHT" },
    });
    expect(listed).not.toHaveProperty("anchor");
    expect(plain).toEqual(expect.objectContaining({ id: note.id, state: "draft" }));
    expect(plain).not.toHaveProperty("changedIn");

    // What PATCH /api/drafts/:id does with that place.
    const where = placeOnDiff([V3], "src/pay.ts", 14, "RIGHT");
    if ("problem" in where) throw new Error(where.problem);
    const moved = drafts.edit(d.id, { place: { ...where, headSha: "h3" } });
    expect(moved).toMatchObject({ state: "draft", line: 14, headSha: "h3", body: "Fees in cents?" });
    expect(draftsAtHead(drafts.list(PR), "h3", [V3])[0]).not.toHaveProperty("movedTo");
  });

  it("offers no place when the code was rewritten, but still says where it changed", () => {
    const drafts = new ReviewDrafts(store);
    drafts.add({ pr: PR, headSha: "h1", body: "Fees in cents?", source: "claude", place: placed() });
    drafts.follow(PR, "h4", [V4]);
    const [listed] = draftsAtHead(drafts.list(PR), "h4", [V4]);
    expect(listed).toMatchObject({ state: "outdated", changedIn: "h4" });
    expect(listed).not.toHaveProperty("movedTo");
  });
});

describe("sending with outdated drafts left out", () => {
  it("sends the rest and keeps the outdated ones, to move or delete; without the option it still refuses", async () => {
    const drafts = new ReviewDrafts(store);
    const old = drafts.add({ pr: PR, headSha: "h1", body: "Fees in cents?", source: "you", place: placed() });
    drafts.follow(PR, "h4", [V4]);
    const note = drafts.add({ pr: PR, headSha: "h4", body: "Looks good otherwise.", source: "you" });
    const gh = fakeGitHub({ head: "h4", patch: V4 });

    await expect(sendReview(gh.client, store, { repo: REPO, number: 7, event: "COMMENT" })).rejects.toMatchObject({
      reason: "outdated",
    });
    const sent = await sendReview(gh.client, store, { repo: REPO, number: 7, event: "COMMENT", leaveOutdated: true });
    expect(sent.posted).toBe(1);
    expect(gh.posted).toHaveLength(1);
    expect(gh.posted[0]).toMatchObject({ body: "Looks good otherwise.", comments: [] });
    expect(drafts.list(PR).map((d) => d.id)).toEqual([old.id]);
    expect(drafts.get(note.id)).toBeUndefined();
  });

  it("still stops when this send is what finds a draft outdated: you haven't seen it", async () => {
    const drafts = new ReviewDrafts(store);
    drafts.add({ pr: PR, headSha: "h1", body: "Fees in cents?", source: "you", place: placed() });
    const gh = fakeGitHub({ head: "h4", patch: V4 });
    await expect(
      sendReview(gh.client, store, { repo: REPO, number: 7, event: "COMMENT", leaveOutdated: true }),
    ).rejects.toMatchObject({ reason: "moved" });
    expect(gh.posted).toEqual([]);
  });
});
