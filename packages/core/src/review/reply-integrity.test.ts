import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Briefing, LlmFinding } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromRestFile } from "../diff/sources.js";
import type { GitHubClient } from "../github/client.js";
import { type RawThread, toReviewThreads } from "../github/threads.js";
import { AldenStore } from "../store/db.js";
import { keepAldenDrafts, makeAldenDrafts } from "./auto-drafts.js";
import { REPLY_MUTATION, ReviewDrafts, SUBMIT_MUTATION, sendReview } from "./drafts.js";

/*
 * A reply posts exactly what you wrote in it, whatever Alden drafts around it. The case behind this: a reply in an
 * outdated thread on py/orders/pricing.py (started on line 4) went out with Alden's draft for line 4 after it, a
 * comment you'd already kept and sent once that day, drafted again when the PR was briefed again.
 */

const REPO = "getalden/alden-e2e-sandbox";
const PR = `${REPO}#75`;
const PATH = "py/orders/pricing.py";
const PATCH = [
  "@@ -1,3 +1,5 @@",
  " def order_total(lines):",
  '     """The total of (quantity, unit_cents) pairs, in cents."""',
  "     return sum(quantity * unit_cents for quantity, unit_cents in lines)",
  "+def price(total, options=None):",
  "+    return total",
].join("\n");
const FILES = [fromRestFile({ filename: PATH, status: "modified", additions: 2, deletions: 0, patch: PATCH })];
const ALDEN =
  "The title says options should be required, but this adds `options=None` as optional and it's never used in the function body. Either make it required and implement its behavior, or update the title/description to reflect what this actually does.";
const MINE = "nevermind all good on this one.";

let home: string;
let store: AldenStore;
const savedHome = process.env.ALDEN_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "alden-reply-integrity-"));
  process.env.ALDEN_HOME = home;
  store = AldenStore.open(join(home, "alden.db"));
});
afterEach(() => {
  store.close();
  if (savedHome === undefined) delete process.env.ALDEN_HOME;
  else process.env.ALDEN_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const finding: LlmFinding = {
  title: "options is optional and unused",
  checkId: "model",
  detail: "The title says required.",
  severity: "medium",
  anchors: [{ path: PATH, line: 4 }],
  draft: { body: ALDEN },
};

const briefing = (at: string) =>
  ({
    schemaVersion: 1,
    target: { kind: "pr", repo: REPO, number: 75, headSha: "h1" },
    generatedAt: at,
    checks: [],
    needsYourEyes: [],
    llm: { status: "ok", findings: [finding], droppedFindings: 0, omittedFiles: [] },
  }) as unknown as Briefing;

const raw = (id: string, body: string, extra: Partial<RawThread> = {}): RawThread => ({
  id,
  path: PATH,
  line: 4,
  startLine: null,
  originalLine: 4,
  diffSide: "RIGHT",
  isResolved: false,
  isOutdated: false,
  viewerCanReply: true,
  viewerCanResolve: true,
  comments: {
    nodes: [
      {
        id: `C_${id}`,
        databaseId: 1,
        author: { login: "me" },
        body,
        createdAt: "2026-10-11T10:00:00Z",
        url: `https://github.com/${REPO}/pull/75#discussion_r1`,
        viewerDidAuthor: true,
      },
    ],
  },
  ...extra,
});

/** GitHub for a send, with the PR's threads; every write kept with what it carried. */
function fakeGitHub(threads: RawThread[]) {
  const writes: { call: string; params: Record<string, unknown> }[] = [];
  const client = {
    request: async (route: string, params: Record<string, unknown>) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return { data: { head: { sha: "h1" } } };
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
        return { data: params.page === 1 ? [{ filename: PATH, status: "modified", patch: PATCH }] : [] };
      }
      writes.push({ call: route, params });
      return { data: { id: 900 + writes.length, node_id: `PRR_${writes.length}`, html_url: "https://x" } };
    },
    graphql: async (query: string, params: Record<string, unknown>) => {
      if (query.includes("reviewThreads")) {
        return { repository: { pullRequest: { headRefOid: "h1", reviewThreads: { nodes: threads } } } };
      }
      writes.push({
        call: query === REPLY_MUTATION ? "reply" : query === SUBMIT_MUTATION ? "submit" : "resolve",
        params,
      });
      return query === SUBMIT_MUTATION ? { submitPullRequestReview: { pullRequestReview: { url: "https://x" } } } : {};
    },
  } as unknown as GitHubClient;
  return { client, writes };
}

describe("a reply in a thread where Alden drafted", () => {
  for (const keepAgain of [false, true]) {
    it(`posts only your words${keepAgain ? ", with Alden's kept draft as its own comment" : ""}`, async () => {
      const drafts = new ReviewDrafts(store);
      // Alden drafts the finding on line 4; you keep it and send it.
      makeAldenDrafts(briefing("2026-10-11T09:00:00.000Z"), FILES, { enabled: true, store });
      await keepAldenDrafts({ pr: PR }, { store, learn: false });
      await sendReview(fakeGitHub([]).client, store, { repo: REPO, number: 75, event: "COMMENT" });
      expect(drafts.list(PR)).toEqual([]);

      // GitHub now has your comment on line 4, and an outdated thread that started on line 4.
      const outdated = raw("PRRT_outdated", "did you change this?", { line: null, isOutdated: true });
      const threads = [raw("PRRT_sent", ALDEN), outdated];
      // The PR is briefed again with a model: the same finding on the same line. Had the threads not been read, Alden
      // would draft it again; it doesn't beside them.
      const again = briefing("2026-10-11T11:00:00.000Z");
      const places = toReviewThreads(REPO, 75, "me", { headRefOid: "h1", reviewThreads: { nodes: threads } }).threads;
      expect(makeAldenDrafts(again, FILES, { enabled: true, store, threads: places }).made).toEqual([]);
      makeAldenDrafts(again, FILES, { enabled: true, store });
      expect(drafts.list(PR).map((d) => [d.line, d.source, d.body])).toEqual([[4, "alden", ALDEN]]);
      // You reply in the outdated thread, then tick Resolve (as the drawer saves them).
      const reply = drafts.addReply({ pr: PR, headSha: "h1", threadId: outdated.id, body: MINE, source: "you" });
      drafts.editReply(reply.id, { resolve: true });
      if (keepAgain) await keepAldenDrafts({ pr: PR }, { store, learn: false });
      // No draft's text is ever another's added to it.
      for (const d of drafts.list(PR)) expect([MINE, ALDEN]).toContain(d.body);

      const gh = fakeGitHub(threads);
      await sendReview(gh.client, store, { repo: REPO, number: 75, event: "COMMENT" });
      const replies = gh.writes.filter((w) => w.call === "reply");
      expect(replies.map((w) => [w.params.thread, w.params.body])).toEqual([[outdated.id, MINE]]);
      const created = gh.writes.find((w) => w.call.startsWith("POST"))?.params;
      expect(created?.comments).toEqual(keepAgain ? [expect.objectContaining({ line: 4, body: ALDEN })] : []);
      expect(created).not.toHaveProperty("body");
      expect(gh.writes.find((w) => w.call === "submit")?.params).not.toHaveProperty("body");
      expect(gh.writes.filter((w) => w.call === "resolve").map((w) => w.params.thread)).toEqual([outdated.id]);
    });
  }
});
