import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FeedbackLog } from "../feedback/log.js";
import { loadLearning } from "../learn/learn.js";
import { AldenStore } from "../store/db.js";
import type { GitHubClient } from "./client.js";
import {
  checkOutcomes,
  decideOutcomes,
  duePullRequests,
  OUTCOMES_QUERY,
  type OutcomePullRequest,
  type OutcomeThread,
  outcomeLine,
  outcomeSummary,
  rememberSentComments,
  type SentCommentInput,
  sentComments,
  suggestionApplied,
} from "./outcomes.js";

const REPO = "acme/shop";
const SENT = new Date("2026-10-01T10:00:00.000Z");
const hours = (n: number) => new Date(SENT.getTime() + n * 60 * 60 * 1000);

let home: string;
let store: AldenStore;
let savedHome: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "alden-outcomes-"));
  savedHome = process.env.ALDEN_HOME;
  process.env.ALDEN_HOME = home;
  store = AldenStore.open(join(home, "alden.db"));
});
afterEach(() => {
  store.close();
  if (savedHome === undefined) delete process.env.ALDEN_HOME;
  else process.env.ALDEN_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const PAY_AT_HEAD = [
  "import { fee } from './fee';",
  "import { tax } from './tax';", // two new lines above: the suggested line moved from 12 to 14
  "",
  ...Array.from({ length: 10 }, (_, i) => `// line ${i + 4}`),
  "const total = a + b + fee + tax;",
  "log(total);",
  "}",
].join("\n");

const suggestion: SentCommentInput = {
  path: "src/pay.ts",
  line: 12,
  side: "RIGHT",
  suggestion: "const total = a + b + fee + tax;",
  lines: ["const total = a + b + fee;"],
  checkId: "paths.sensitive",
};
const comment: SentCommentInput = { path: "src/pay.ts", line: 20, startLine: 18, side: "RIGHT" };
const other: SentCommentInput = { path: "src/cart.ts", line: 5, side: "RIGHT" };

/** A thread as GitHub's GraphQL API returns it, started by comment `id` in review `review`. */
function thread(
  at: SentCommentInput,
  state: { resolved?: boolean; outdated?: boolean; line?: number | null },
  id: number,
  review = 501,
): OutcomeThread {
  return {
    isResolved: state.resolved ?? false,
    isOutdated: state.outdated ?? false,
    path: at.path,
    line: state.line === undefined ? at.line : state.line,
    startLine: null,
    originalLine: at.line,
    originalStartLine: at.startLine ?? null,
    diffSide: at.side,
    comments: {
      nodes: [{ databaseId: id, author: { login: "you" }, pullRequestReview: { databaseId: review } }],
    },
  };
}

function pullRequest(
  threads: OutcomeThread[],
  extra: Partial<Pick<OutcomePullRequest, "state" | "headRefOid">> & { committed?: string[] } = {},
): OutcomePullRequest {
  return {
    state: extra.state ?? "OPEN",
    headRefOid: extra.headRefOid ?? "h1",
    commits: {
      nodes: (extra.committed ?? ["2026-09-30T09:00:00.000Z"]).map((committedDate, i) => ({
        commit: { oid: `c${i}`, committedDate },
      })),
    },
    reviewThreads: { nodes: threads },
  };
}

/** A stand-in GitHub that answers the outcomes query per PR and reads files at "oid:path". Nothing reaches GitHub. */
function fakeGitHub(prs: Record<number, OutcomePullRequest | Error>, blobs: Record<string, string> = {}) {
  const calls: { kind: "outcomes" | "files"; vars: Record<string, unknown>; query: string }[] = [];
  const client = {
    graphql: async (query: string, vars: Record<string, unknown>) => {
      if (query === OUTCOMES_QUERY) {
        calls.push({ kind: "outcomes", vars, query });
        const pr = prs[vars.number as number];
        if (pr instanceof Error) throw pr;
        return { repository: { pullRequest: pr ?? null } };
      }
      calls.push({ kind: "files", vars, query });
      const repository: Record<string, { text: string } | null> = {};
      for (const [, alias, expression] of query.matchAll(/(f\d+): object\(expression: ("[^"]*")\)/g)) {
        const text = blobs[JSON.parse(expression as string) as string];
        repository[alias as string] = text === undefined ? null : { text };
      }
      return { repository };
    },
    request: async (route: string) => {
      throw new Error(`unexpected ${route}`);
    },
  } as unknown as GitHubClient;
  return { client, calls };
}

const remember = (number: number, comments: SentCommentInput[], at = SENT, headSha = "h1", reviewId = 501) =>
  rememberSentComments(store, { repo: REPO, number, reviewId, headSha, sentAt: at.toISOString() }, comments);

describe("whether a suggestion was applied", () => {
  it("finds its code at the head near where it was suggested, with the code it replaced gone", () => {
    expect(suggestionApplied(PAY_AT_HEAD, suggestion)).toBe(true);
    // Not yet: the old line is still there.
    expect(suggestionApplied(PAY_AT_HEAD.replace("fee + tax;", "fee;"), suggestion)).toBe(false);
    // A formatter's re-indent still counts.
    expect(suggestionApplied(PAY_AT_HEAD.replace("const total", "    const total"), suggestion)).toBe(true);
    // Too far away to be this suggestion.
    const far = [...Array.from({ length: 200 }, () => "x"), "const total = a + b + fee + tax;"].join("\n");
    expect(suggestionApplied(far, suggestion)).toBe(false);
  });

  it("takes a deletion as applied when the lines are gone, and never a suggestion that changes nothing", () => {
    const deletion = { ...suggestion, suggestion: "", lines: ["log(total);"] };
    expect(suggestionApplied(PAY_AT_HEAD, deletion)).toBe(false);
    expect(suggestionApplied(PAY_AT_HEAD.replace("log(total);\n", ""), deletion)).toBe(true);
    const same = {
      ...suggestion,
      suggestion: "const total = a + b + fee + tax;",
      lines: [suggestion.suggestion ?? ""],
    };
    expect(suggestionApplied(PAY_AT_HEAD, same)).toBe(false);
    // A suggestion that adds a line after the old one keeps it.
    const adds = { ...suggestion, suggestion: "log(total);\nreturn total;", lines: ["log(total);"] };
    expect(suggestionApplied(PAY_AT_HEAD.replace("log(total);", "log(total);\nreturn total;"), adds)).toBe(true);
  });
});

describe("deciding outcomes", () => {
  it("matches a thread by the review that started it and its original lines", () => {
    remember(7, [suggestion, comment]);
    const sent = sentComments(store, REPO, 7);
    const pr = pullRequest([
      thread(comment, { resolved: true }, 11, 999), // another review's thread at the same place
      thread(suggestion, {}, 12),
    ]);
    expect(decideOutcomes(sent, pr)).toEqual([]);
  });

  it("counts an outdated thread only after a push", () => {
    remember(7, [comment]);
    const sent = sentComments(store, REPO, 7);
    const outdated = [thread(comment, { outdated: true, line: null }, 11)];
    expect(decideOutcomes(sent, pullRequest(outdated))).toEqual([]);
    expect(decideOutcomes(sent, pullRequest(outdated, { headRefOid: "h2" }))).toEqual([
      expect.objectContaining({ signal: "resolved" }),
    ]);
    expect(decideOutcomes(sent, pullRequest(outdated, { committed: [hours(1).toISOString()] }))).toEqual([
      expect.objectContaining({ signal: "resolved" }),
    ]);
  });
});

describe("checking outcomes", () => {
  it("records an applied suggestion and a resolved comment once each, as outcome signals", async () => {
    remember(7, [suggestion, comment, other]);
    const pr = pullRequest(
      [
        thread(suggestion, { resolved: true, line: 14 }, 11),
        thread(comment, { resolved: true }, 12),
        thread(other, {}, 13),
      ],
      { headRefOid: "h2" },
    );
    const gh = fakeGitHub({ 7: pr }, { "h2:src/pay.ts": PAY_AT_HEAD });

    const first = await checkOutcomes(gh.client, store, { now: hours(2) });
    expect(first).toMatchObject({ checked: 1, failed: 0 });
    expect(first.recorded).toEqual([
      {
        schemaVersion: 1,
        id: expect.stringMatching(/^outcome-[0-9a-f]{24}$/),
        type: "review_signal",
        repo: REPO,
        pr: 7,
        at: hours(2).toISOString(),
        signal: "applied",
        checkId: "paths.sensitive",
        path: "src/pay.ts",
        line: 12,
        weight: 2,
        source: "outcome",
      },
      {
        schemaVersion: 1,
        id: expect.stringMatching(/^outcome-[0-9a-f]{24}$/),
        type: "review_signal",
        repo: REPO,
        pr: 7,
        at: hours(2).toISOString(),
        signal: "resolved",
        path: "src/pay.ts",
        line: 20,
        weight: 1,
        source: "outcome",
      },
    ]);
    // One request for the threads, one for the suggestion's file at the head.
    expect(gh.calls.map((c) => c.kind)).toEqual(["outcomes", "files"]);
    expect(gh.calls[0]?.vars).toEqual({ owner: "acme", name: "shop", number: 7 });
    expect(sentComments(store, REPO, 7).map((c) => c.commentId)).toEqual([11, 12, 13]);

    // Within the day: no request at all.
    await checkOutcomes(gh.client, store, { now: hours(20) });
    expect(gh.calls).toHaveLength(2);

    // A day later: asked again, nothing new recorded, and the file isn't read again at the same head.
    const again = await checkOutcomes(gh.client, store, { now: hours(27) });
    expect(again).toMatchObject({ checked: 1, recorded: [] });
    expect(gh.calls.map((c) => c.kind)).toEqual(["outcomes", "files", "outcomes"]);
    expect(new FeedbackLog(store).signals()).toHaveLength(2);
    expect(outcomeLine(outcomeSummary(store, hours(27)))).toBe(
      "Outcomes: 1 suggestion applied, 1 comment resolved (last 14 days)",
    );
    // The applied suggestion counts toward its check's lesson, as an outcome of acme/shop#7; the resolved comment was
    // near no flagged place, so it teaches no check.
    const learning = await loadLearning(store, REPO, hours(27));
    expect(learning.checkTallies.get("paths.sensitive")).toMatchObject({ agree: 2, reviewAgree: 2 });
    expect([...learning.checkTallies.keys()]).toEqual(["paths.sensitive"]);
  });

  it("counts a suggestion resolved without its code as resolved, and as applied too if the code lands later", async () => {
    remember(7, [suggestion]);
    const resolved = [thread(suggestion, { resolved: true }, 11)];
    const before = PAY_AT_HEAD.replace("fee + tax;", "fee;");
    const gh = fakeGitHub({ 7: pullRequest(resolved) }, { "h1:src/pay.ts": before, "h2:src/pay.ts": PAY_AT_HEAD });
    expect((await checkOutcomes(gh.client, store, { now: hours(1) })).recorded.map((s) => s.signal)).toEqual([
      "resolved",
    ]);
    const later = fakeGitHub({ 7: pullRequest(resolved, { headRefOid: "h2" }) }, { "h2:src/pay.ts": PAY_AT_HEAD });
    expect((await checkOutcomes(later.client, store, { now: hours(26) })).recorded.map((s) => s.signal)).toEqual([
      "applied",
    ]);
    expect(outcomeSummary(store, hours(26))).toMatchObject({ applied: 1, resolved: 1 });
  });

  it("checks a closed PR once more, then stops", async () => {
    remember(7, [comment]);
    const gh = fakeGitHub({ 7: pullRequest([thread(comment, { resolved: true }, 11)], { state: "MERGED" }) });
    expect((await checkOutcomes(gh.client, store, { now: hours(1) })).recorded).toHaveLength(1);
    await checkOutcomes(gh.client, store, { now: hours(48) });
    expect(gh.calls).toHaveLength(1);
  });

  it("only watches reviews from the last 14 days, and keeps sent comments 30", async () => {
    remember(7, [comment], SENT);
    remember(8, [other], hours(24 * 15));
    expect(duePullRequests(store, hours(24 * 15)).map((pr) => pr.number)).toEqual([8]);
    remember(9, [other], hours(24 * 31));
    expect(sentComments(store, REPO, 7)).toEqual([]);
    expect(sentComments(store, REPO, 8)).toHaveLength(1);
  });

  it("swallows a PR's failure, leaves it for tomorrow, and checks the others", async () => {
    remember(7, [comment]);
    remember(8, [comment]);
    const gh = fakeGitHub({
      7: new Error("rate limited"),
      8: pullRequest([thread(comment, { resolved: true }, 11)]),
    });
    const result = await checkOutcomes(gh.client, store, { now: hours(1) });
    expect(result).toMatchObject({ checked: 1, failed: 1 });
    expect(result.recorded.map((s) => s.pr)).toEqual([8]);
    expect(duePullRequests(store, hours(2))).toEqual([]);
    expect(duePullRequests(store, hours(26)).map((pr) => pr.number)).toEqual([7, 8]);
  });

  it("stops watching a PR GitHub can't find", async () => {
    remember(7, [comment]);
    const gone = Object.assign(new Error("Could not resolve to a PullRequest"), { errors: [{ type: "NOT_FOUND" }] });
    const gh = fakeGitHub({ 7: gone });
    expect(await checkOutcomes(gh.client, store, { now: hours(1) })).toMatchObject({ checked: 1, failed: 0 });
    await checkOutcomes(gh.client, store, { now: hours(48) });
    expect(gh.calls).toHaveLength(1);
  });

  it("does nothing when learning from reviews is off", async () => {
    writeFileSync(join(home, "config.toml"), "[learning]\nfromReviews = false\n");
    remember(7, [comment]);
    const gh = fakeGitHub({ 7: pullRequest([thread(comment, { resolved: true }, 11)]) });
    expect(await checkOutcomes(gh.client, store, { now: hours(1) })).toEqual({ checked: 0, failed: 0, recorded: [] });
    expect(gh.calls).toEqual([]);
  });

  it("shares one run between calls at once, and says nothing with nothing watched", async () => {
    expect(outcomeLine(outcomeSummary(store, hours(1)))).toBeUndefined();
    remember(7, [comment]);
    const gh = fakeGitHub({ 7: pullRequest([]) });
    await Promise.all([
      checkOutcomes(gh.client, store, { now: hours(1) }),
      checkOutcomes(gh.client, store, { now: hours(1) }),
    ]);
    expect(gh.calls).toHaveLength(1);
    expect(outcomeLine(outcomeSummary(store, hours(1)))).toBe(
      "Outcomes: 0 suggestions applied, 0 comments resolved (last 14 days)",
    );
  });
});
