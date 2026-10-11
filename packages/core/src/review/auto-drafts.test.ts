import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Briefing, LlmFinding } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromRestFile } from "../diff/sources.js";
import { FeedbackLog } from "../feedback/log.js";
import type { GitHubClient } from "../github/client.js";
import { loadLearning } from "../learn/learn.js";
import { AldenStore } from "../store/db.js";
import { aldenDraftsLine, dropAldenDrafts, keepAldenDrafts, MAX_ALDEN_DRAFTS, makeAldenDrafts } from "./auto-drafts.js";
import { placeOnDiff, ReviewDrafts, sendReview } from "./drafts.js";

const REPO = "acme/shop";
const PR = "acme/shop#7";
const PATH = "src/pay.ts";
/** A new file of 40 lines, `const v1 = 1;` to `const v40 = 40;`: every line is added, so every line takes a comment. */
const PATCH = ["@@ -0,0 +1,40 @@", ...Array.from({ length: 40 }, (_, i) => `+const v${i + 1} = ${i + 1};`)].join("\n");
const FILES = [fromRestFile({ filename: PATH, status: "added", additions: 40, deletions: 0, patch: PATCH })];

let home: string;
let store: AldenStore;
const savedHome = process.env.ALDEN_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "alden-auto-drafts-"));
  process.env.ALDEN_HOME = home;
  store = AldenStore.open(join(home, "alden.db"));
});
afterEach(() => {
  store.close();
  if (savedHome === undefined) delete process.env.ALDEN_HOME;
  else process.env.ALDEN_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const finding = (line: number, extra: Partial<LlmFinding> = {}): LlmFinding => ({
  title: `Finding on ${line}`,
  checkId: "tests.missing",
  detail: "Why it matters.",
  severity: "medium",
  anchors: [{ path: PATH, line }],
  draft: { body: `Line ${line} needs a test.` },
  ...extra,
});

const briefingOf = (findings: LlmFinding[], extra: Partial<Briefing> = {}): Briefing =>
  ({
    schemaVersion: 1,
    target: { kind: "pr", repo: REPO, number: 7, headSha: "h1" },
    generatedAt: "2026-10-01T00:00:00.000Z",
    checks: [],
    needsYourEyes: [],
    llm: { status: "ok", findings, droppedFindings: 0, omittedFiles: [] },
    ...extra,
  }) as unknown as Briefing;

const make = (b: Briefing, enabled = true) => makeAldenDrafts(b, FILES, { enabled, store });

describe("making Alden's drafts from a model briefing", () => {
  it("drafts the most severe findings first, at most five, on their first line, marked as Alden's", () => {
    const findings = [2, 7, 12, 17, 22, 27, 32].map((line) => finding(line));
    findings[6] = finding(32, { severity: "high", draft: { body: "Guard this.", suggestion: "const v32 = 0;" } });
    const { made } = make(briefingOf(findings));
    expect(made).toHaveLength(MAX_ALDEN_DRAFTS);
    expect(made.map((d) => d.line)).toEqual([32, 2, 7, 12, 17]);
    const listed = new ReviewDrafts(store).list(PR);
    expect(listed.find((d) => d.line === 32)).toMatchObject({
      source: "alden",
      body: "Guard this.",
      suggestion: "const v32 = 0;",
      originalLines: ["const v32 = 32;"],
      drafted: { checkId: "tests.missing", title: "Finding on 32" },
      headSha: "h1",
    });
  });

  it("skips low findings, findings without a draft or a line, places GitHub won't take, and places near a draft", () => {
    const drafts = new ReviewDrafts(store);
    const yours = placeOnDiff(FILES, PATH, 20, "RIGHT");
    if ("problem" in yours) throw new Error(yours.problem);
    drafts.add({ pr: PR, headSha: "h1", body: "Mine.", source: "you", place: yours });
    const { made } = make(
      briefingOf([
        finding(2, { severity: "low" }),
        finding(5, { draft: undefined }),
        finding(8, { anchors: [{ path: PATH }] }),
        finding(10, { anchors: [{ path: "src/other.ts", line: 10 }] }),
        finding(22),
        finding(30, { checkId: undefined }),
        finding(31),
      ]),
    );
    // 22 is near your comment on 20; 31 is near Alden's own on 30.
    expect(made.map((d) => [d.line, d.drafted?.checkId])).toEqual([[30, "model"]]);
  });

  it("replaces its untouched drafts on a new briefing, and never touches one you kept or edited", async () => {
    make(briefingOf([finding(2), finding(10)]));
    const [first] = new ReviewDrafts(store).list(PR);
    await keepAldenDrafts({ ids: [first?.id as string] }, { store, learn: false });
    const again = make(briefingOf([finding(2), finding(20)]));
    // The kept one on line 2 is yours now, so Alden doesn't draft beside it again; 10 is replaced by 20.
    expect(again).toMatchObject({ replaced: 1 });
    expect(new ReviewDrafts(store).list(PR).map((d) => [d.line, d.source])).toEqual([
      [2, "you"],
      [20, "alden"],
    ]);
  });

  it("makes none when turned off, for local changes, without the model's answer, or when the PR talks to AI", () => {
    const b = briefingOf([finding(2)]);
    expect(make(b, false).made).toEqual([]);
    expect(make({ ...b, target: { kind: "local", repoRoot: "/x", branch: null } }).made).toEqual([]);
    expect(make({ ...b, llm: { ...(b.llm as NonNullable<Briefing["llm"]>), status: "failed" } }).made).toEqual([]);
    expect(makeAldenDrafts(b, undefined, { enabled: true, store }).made).toEqual([]);
    const injected = {
      ...b,
      checks: [
        {
          id: "injection.ai",
          title: "Text aimed at AI reviewers",
          status: "flagged" as const,
          severity: "high" as const,
          summary: "s",
          evidence: [],
          heuristic: true,
        },
      ],
    };
    expect(make(injected).made).toEqual([]);
    expect(new ReviewDrafts(store).list(PR)).toEqual([]);
  });

  it("skips a finding your feedback hid", () => {
    const b = briefingOf([finding(2)], { learning: { hidden: [{ title: "Finding on 2", reason: "r" }], memory: 0 } });
    expect(make(b).made).toEqual([]);
  });

  it('says what it drafted, for `alden review`: "Alden drafted N comments"', () => {
    expect(aldenDraftsLine(0, PR)).toBeUndefined();
    expect(aldenDraftsLine(1, PR)).toBe("Alden drafted 1 comment — see them with `alden comment acme/shop#7`");
    expect(aldenDraftsLine(3, PR)).toBe("Alden drafted 3 comments — see them with `alden comment acme/shop#7`");
  });
});

describe("keeping and dropping Alden's drafts", () => {
  it("keeping makes a draft yours and counts once as a comment near its finding", async () => {
    make(briefingOf([finding(2), finding(10, { checkId: undefined })]));
    const { kept, signals } = await keepAldenDrafts({ pr: PR }, { store, learn: true });
    expect(kept.map((d) => [d.source, d.drafted?.title])).toEqual([
      ["you", "Finding on 2"],
      ["you", "Finding on 10"],
    ]);
    // Only the finding with a check teaches one.
    expect(signals).toEqual([
      expect.objectContaining({ signal: "comment", checkId: "tests.missing", path: PATH, line: 2, weight: 1 }),
    ]);
    // Keeping again: nothing is Alden's any more, so nothing changes or counts.
    expect(await keepAldenDrafts({ pr: PR }, { store, learn: true })).toEqual({ kept: [], signals: [] });
    expect(new FeedbackLog(store).signals(REPO)).toHaveLength(1);
  });

  it("learns nothing while learning from reviews is off", async () => {
    make(briefingOf([finding(2)]));
    const { kept, signals } = await keepAldenDrafts({ pr: PR }, { store, learn: false });
    expect(kept).toHaveLength(1);
    expect(signals).toEqual([]);
  });

  it("dropping deletes a draft and counts as a weak not-useful, never for checks Alden never quietens", async () => {
    make(
      briefingOf([
        finding(2),
        finding(10, { checkId: "secrets.likely", title: "Secret" }),
        finding(20, { checkId: undefined }),
      ]),
    );
    const ids = new ReviewDrafts(store).list(PR).map((d) => d.id);
    const { dropped, signals } = await dropAldenDrafts(ids, { store, learn: true });
    expect(dropped).toHaveLength(3);
    expect(new ReviewDrafts(store).list(PR)).toEqual([]);
    expect(signals).toEqual([
      expect.objectContaining({ signal: "silent_pass", checkId: "tests.missing", weight: 0.2, line: 2 }),
    ]);
    // A drop alone never quietens a check.
    expect((await loadLearning(store, REPO)).checkTallies.get("tests.missing")).toMatchObject({
      notNeeded: 0.2,
      saidNotNeeded: 0,
    });
  });

  it("leaves drafts that aren't Alden's to the ordinary delete", async () => {
    const yours = placeOnDiff(FILES, PATH, 2, "RIGHT");
    if ("problem" in yours) throw new Error(yours.problem);
    const draft = new ReviewDrafts(store).add({ pr: PR, headSha: "h1", body: "Mine.", source: "you", place: yours });
    expect((await dropAldenDrafts([draft.id], { store, learn: true })).dropped).toEqual([]);
    expect(new ReviewDrafts(store).get(draft.id)).toBeDefined();
  });
});

describe("sending with Alden's drafts", () => {
  /** A fake GitHub for one PR at head h1 with FILES; nothing reaches GitHub. */
  function fakeGitHub() {
    const posted: Record<string, unknown>[] = [];
    const client = {
      request: async (route: string, params: Record<string, unknown>) => {
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return { data: { head: { sha: "h1" } } };
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
          const raw = { filename: PATH, status: "added", additions: 40, deletions: 0, patch: PATCH };
          return { data: params.page === 1 ? [raw] : [] };
        }
        if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
          posted.push(params);
          return { data: { id: 9, html_url: "https://github.com/acme/shop/pull/7#pullrequestreview-9" } };
        }
        throw new Error(`unexpected ${route}`);
      },
    } as unknown as GitHubClient;
    return { client, posted };
  }

  it("posts only the drafts you kept or edited, never an untouched one, and doesn't count them as misses", async () => {
    const b = briefingOf([finding(2), finding(10)]);
    new ReviewDrafts(store).rememberBriefing(b);
    make(b);
    const [first] = new ReviewDrafts(store).list(PR);
    await keepAldenDrafts({ ids: [first?.id as string] }, { store, learn: true });
    const gh = fakeGitHub();
    const sent = await sendReview(gh.client, store, { repo: REPO, number: 7, event: "COMMENT" }, new Date(), {
      fromReviews: true,
    });
    expect(sent.posted).toBe(1);
    expect(gh.posted[0]?.comments).toEqual([{ path: PATH, line: 2, side: "RIGHT", body: "Line 2 needs a test." }]);
    // The keep already counted the comment near the finding; the send adds no miss for it.
    expect(new FeedbackLog(store).signals(REPO).map((s) => s.signal)).toEqual(["comment"]);
  });

  it("sends nothing of Alden's when you kept none", async () => {
    make(briefingOf([finding(2)]));
    const gh = fakeGitHub();
    const sent = await sendReview(gh.client, store, { repo: REPO, number: 7, event: "COMMENT", body: "Looks fine." });
    expect(sent.posted).toBe(0);
    expect(gh.posted[0]?.comments).toEqual([]);
  });
});
