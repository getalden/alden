import { AldenConfigSchema, type PullRequestFacts, RankedQueueSchema } from "@alden/schema";
import { describe, expect, it } from "vitest";
import { rankPullRequest, rankQueue } from "./rank.js";
import { followUpOf, isRereview, REREVIEW_REASON } from "./rereview.js";

const config = AldenConfigSchema.parse({}).queue;
const NOW = Date.parse("2026-10-10T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

type Review = PullRequestFacts["reviews"][number];
const review = (author: string | null, state: string, hours: number | null, commit?: string): Review => ({
  author,
  state,
  submittedAt: hours === null ? null : hoursAgo(hours),
  ...(commit ? { commit } : {}),
});

function facts(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    repo: "acme/api",
    number: 7,
    title: "Charge in the customer's currency",
    url: "https://github.com/acme/api/pull/7",
    author: "sam",
    authorIsBot: false,
    isDraft: false,
    createdAt: hoursAgo(100),
    updatedAt: hoursAgo(1),
    baseRef: "main",
    headRef: "sam/currency",
    additions: 20,
    deletions: 5,
    changedFiles: 2,
    files: [
      { path: "src/app.ts", additions: 15, deletions: 5 },
      { path: "src/app.test.ts", additions: 5, deletions: 0 },
    ],
    filesTruncated: false,
    labels: [],
    ci: "success",
    mergeable: "mergeable",
    reviews: [],
    request: { direct: true, teams: [], requestedAt: hoursAgo(2) },
    codeownedFiles: [],
    stackedPrs: 0,
    ...overrides,
  };
}

describe("followUpOf", () => {
  it("is undefined when you've never submitted a review", () => {
    expect(followUpOf(facts(), "me")).toBeUndefined();
    // Someone else's review, and your own pending one, aren't yours to follow up.
    const reviews = [review("ana", "APPROVED", 10), review("me", "PENDING", 5), review("me", "COMMENTED", null)];
    expect(followUpOf(facts({ reviews }), "me")).toBeUndefined();
  });

  it("is a re-review when you were asked after your last review, with the head you reviewed", () => {
    const reviews = [review("Me", "CHANGES_REQUESTED", 30, "aaa111"), review("ana", "APPROVED", 20, "bbb222")];
    const followUp = followUpOf(
      facts({ reviews, request: { direct: true, teams: [], requestedAt: hoursAgo(3) } }),
      "me",
    );
    expect(followUp).toEqual({
      pr: "acme/api#7",
      lastReviewedAt: hoursAgo(30),
      lastReviewedHead: "aaa111",
      rereviewRequestedAt: hoursAgo(3),
      yourThreads: 0,
      resolved: 0,
      replied: 0,
    });
    expect(isRereview(followUp)).toBe(true);
  });

  it("counts a request to one of your teams", () => {
    const reviews = [review("me", "COMMENTED", 30)];
    const request = { direct: false, teams: ["acme/payments"], requestedAt: hoursAgo(3) };
    expect(followUpOf(facts({ reviews, request }), "me")?.rereviewRequestedAt).toBe(hoursAgo(3));
  });

  it("uses your latest review, whatever order GitHub lists them in", () => {
    const reviews = [review("me", "APPROVED", 4, "new"), review("me", "COMMENTED", 40, "old")];
    const followUp = followUpOf(
      facts({ reviews, request: { direct: true, teams: [], requestedAt: hoursAgo(10) } }),
      "me",
    );
    expect(followUp).toMatchObject({ lastReviewedAt: hoursAgo(4), lastReviewedHead: "new" });
    // You were asked before your latest review: you've answered it, so it isn't a re-review.
    expect(followUp).not.toHaveProperty("rereviewRequestedAt");
    expect(isRereview(followUp)).toBe(false);
  });

  it("counts a dismissed review as one you gave", () => {
    const followUp = followUpOf(facts({ reviews: [review("me", "DISMISSED", 30)] }), "me");
    expect(followUp?.rereviewRequestedAt).toBe(hoursAgo(2));
  });

  it("leaves out the head when GitHub didn't say it, as in queues cached before Alden read it", () => {
    const followUp = followUpOf(facts({ reviews: [review("me", "APPROVED", 30)] }), "me");
    expect(followUp).not.toHaveProperty("lastReviewedHead");
  });

  it("isn't a re-review when GitHub recorded no request", () => {
    const followUp = followUpOf(
      facts({ reviews: [review("me", "APPROVED", 30)], request: { direct: true, teams: [], requestedAt: null } }),
      "me",
    );
    expect(isRereview(followUp)).toBe(false);
  });
});

describe("ranking a re-review", () => {
  const context = { now: NOW, authorQueueSize: 1, viewer: "me" };
  const reviewed = [review("me", "CHANGES_REQUESTED", 30, "aaa111")];

  it("adds 2 points and leads with the reason, so it sits above a first look of the same risk", () => {
    const first = rankPullRequest(facts({ number: 1 }), config, context);
    const again = rankPullRequest(facts({ number: 2, reviews: reviewed }), config, context);
    expect(again.score.total).toBe(first.score.total + 2);
    expect(again.score.blocking).toBe(first.score.blocking + 1);
    expect(again.reasons[0]).toBe(REREVIEW_REASON);
    expect(again.breakdown).toContainEqual({ signal: "rereview", points: 2, text: REREVIEW_REASON });
    expect(again.followUp).toMatchObject({ lastReviewedHead: "aaa111", rereviewRequestedAt: hoursAgo(2) });
    expect(first).not.toHaveProperty("followUp");

    const queue = rankQueue(
      {
        viewer: "me",
        fetchedAt: hoursAgo(0),
        warnings: [],
        pullRequests: [facts({ number: 1 }), facts({ number: 2, reviews: reviewed })],
      },
      config,
      NOW,
    );
    expect(queue.needsYou.map((r) => r.pr.number)).toEqual([2, 1]);
    expect(RankedQueueSchema.safeParse(JSON.parse(JSON.stringify(queue))).error).toBeUndefined();
  });

  it("follows its weight, and 0 ignores it but keeps the follow-up on the row", () => {
    const pr = facts({ reviews: reviewed });
    const doubled = rankPullRequest(pr, { ...config, rank: { ...config.rank, rereview: 2 } }, context);
    expect(doubled.breakdown).toContainEqual({ signal: "rereview", points: 4, weight: 2, text: REREVIEW_REASON });

    const off = rankPullRequest(pr, { ...config, rank: { ...config.rank, rereview: 0 } }, context);
    expect(off.score.total).toBe(rankPullRequest(facts(), config, context).score.total);
    expect(off.reasons).not.toContain(REREVIEW_REASON);
    expect(off.followUp?.rereviewRequestedAt).toBe(hoursAgo(2));
  });

  it("carries a follow-up with no bump when you reviewed and weren't asked again", () => {
    const pr = facts({ reviews: [review("me", "APPROVED", 1, "bbb")] });
    const r = rankPullRequest(pr, config, context);
    expect(r.followUp).toMatchObject({ lastReviewedHead: "bbb" });
    expect(r.reasons).not.toContain(REREVIEW_REASON);
    expect(r.score.total).toBe(rankPullRequest(facts(), config, context).score.total);
  });

  it("needs a viewer to know whose review it is", () => {
    const r = rankPullRequest(facts({ reviews: reviewed }), config, { now: NOW, authorQueueSize: 1 });
    expect(r).not.toHaveProperty("followUp");
  });
});
