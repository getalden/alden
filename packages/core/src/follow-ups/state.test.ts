import type { ReviewThread, ReviewThreadComment, ReviewThreads } from "@alden/schema";
import { describe, expect, it } from "vitest";
import { compareFollowUp, type FollowedPr, isYourTurn, parseState, stateCounts } from "./state.js";

const PR: FollowedPr = {
  repo: "acme/shop",
  number: 12,
  title: "Charge tax",
  url: "https://github.com/acme/shop/pull/12",
  author: "ana",
};
const NOW = new Date("2026-10-11T12:00:00.000Z");

const c = (id: string, who: string, at: string): ReviewThreadComment => ({
  id,
  databaseId: null,
  author: who,
  isYou: who === "sam",
  body: "text",
  createdAt: `2026-10-${at}:00.000Z`,
  url: `https://github.com/acme/shop/pull/12#${id}`,
});

const t = (id: string, comments: ReviewThreadComment[], extra: Partial<ReviewThread> = {}): ReviewThread => ({
  id,
  path: "src/pay.ts",
  line: 40,
  startLine: null,
  originalLine: 40,
  side: "RIGHT",
  isResolved: false,
  isOutdated: false,
  startedByYou: comments[0]?.isYou ?? false,
  viewerCanReply: true,
  viewerCanResolve: true,
  comments,
  ...extra,
});

const threads = (...list: ReviewThread[]): ReviewThreads => ({
  schemaVersion: 1,
  pr: "acme/shop#12",
  headSha: "h1",
  viewer: "sam",
  threads: list,
});

describe("compareFollowUp", () => {
  it("only takes a baseline the first time, whatever has happened", () => {
    const first = compareFollowUp(
      PR,
      undefined,
      threads(t("T1", [c("a", "sam", "01T10:00"), c("b", "ana", "02T10:00")], { isResolved: true })),
      "2026-10-03T10:00:00.000Z",
      NOW,
    );
    expect(first.events).toEqual([]);
    expect(first.state.rereviewSeen).toBe("2026-10-03T10:00:00.000Z");
    // Already your turn at the baseline: not told later for the same round.
    expect(first.state.turn).toBe("a");
    expect(first.state.threads.T1).toMatchObject({ resolved: true, last: "b", where: "src/pay.ts:40" });
  });

  it("keeps only the threads you're in", () => {
    const { state } = compareFollowUp(
      PR,
      undefined,
      threads(t("T1", [c("a", "sam", "01T10:00")]), t("T2", [c("x", "bo", "01T10:00"), c("y", "ana", "01T11:00")])),
      undefined,
      NOW,
    );
    expect(Object.keys(state.threads)).toEqual(["T1"]);
  });

  it("records each reply after yours once, with a stable id", () => {
    const before = compareFollowUp(PR, undefined, threads(t("T1", [c("a", "sam", "01T10:00")])), undefined, NOW).state;
    const now = threads(
      t("T1", [c("a", "sam", "01T10:00"), c("b", "ana", "02T10:00"), c("d", "bo", "02T11:00")]),
      t("T2", [c("x", "bo", "01T10:00"), c("y", "ana", "02T10:00")]),
    );
    const { events, state } = compareFollowUp(PR, before, now, undefined, NOW);
    const replies = events.filter((e) => e.kind === "reply");
    expect(replies.map((e) => e.text)).toEqual([
      "ana replied to your comment on src/pay.ts:40",
      "bo replied to your comment on src/pay.ts:40",
    ]);
    expect(replies[0]?.at).toBe("2026-10-02T10:00:00.000Z");
    // Seen once: the next check finds nothing new.
    const again = compareFollowUp(PR, state, now, undefined, NOW);
    expect(again.events.filter((e) => e.kind === "reply")).toEqual([]);
    // The same happening has the same id, so the database records it once even if compared again from scratch.
    expect(compareFollowUp(PR, before, now, undefined, NOW).events.map((e) => e.id)).toEqual(events.map((e) => e.id));
  });

  it("counts replies only after your first comment in a thread someone else started", () => {
    const before = compareFollowUp(
      PR,
      undefined,
      threads(t("T1", [c("x", "bo", "01T09:00"), c("a", "sam", "01T10:00")])),
      undefined,
      NOW,
    ).state;
    const { events } = compareFollowUp(
      PR,
      before,
      threads(t("T1", [c("x", "bo", "01T09:00"), c("a", "sam", "01T10:00"), c("b", "bo", "02T10:00")])),
      undefined,
      NOW,
    );
    expect(events.filter((e) => e.kind === "reply").map((e) => e.text)).toEqual([
      "bo replied to your comment on src/pay.ts:40",
    ]);
  });

  it("records a resolve and a push that made your thread outdated", () => {
    const before = compareFollowUp(PR, undefined, threads(t("T1", [c("a", "sam", "01T10:00")])), undefined, NOW).state;
    const { events } = compareFollowUp(
      PR,
      before,
      threads(t("T1", [c("a", "sam", "01T10:00")], { isResolved: true, isOutdated: true, line: null })),
      undefined,
      NOW,
    );
    expect(events.map((e) => [e.kind, e.text])).toEqual([
      ["resolved", "Your comment on src/pay.ts:40 was resolved"],
      ["outdated", "A push changed the code under your comment on src/pay.ts"],
      ["your-turn", "Your turn: every comment you left is resolved or answered"],
    ]);
  });

  it("tells your turn once per round: again only after you've said something new", () => {
    const base = compareFollowUp(
      PR,
      undefined,
      threads(t("T1", [c("a", "sam", "01T10:00")]), t("T2", [c("e", "sam", "01T10:30")])),
      undefined,
      NOW,
    ).state;
    // One answered, one still open: not yet.
    const half = compareFollowUp(
      PR,
      base,
      threads(t("T1", [c("a", "sam", "01T10:00"), c("b", "ana", "02T10:00")]), t("T2", [c("e", "sam", "01T10:30")])),
      undefined,
      NOW,
    );
    expect(half.events.map((e) => e.kind)).toEqual(["reply"]);
    const all = compareFollowUp(
      PR,
      half.state,
      threads(
        t("T1", [c("a", "sam", "01T10:00"), c("b", "ana", "02T10:00")]),
        t("T2", [c("e", "sam", "01T10:30")], { isResolved: true }),
      ),
      undefined,
      NOW,
    );
    expect(all.events.map((e) => e.kind)).toEqual(["resolved", "your-turn"]);
    // Unresolved and resolved again, nothing new from you: no second "your turn".
    const reopened = compareFollowUp(
      PR,
      all.state,
      threads(t("T1", [c("a", "sam", "01T10:00"), c("b", "ana", "02T10:00")]), t("T2", [c("e", "sam", "01T10:30")])),
      undefined,
      NOW,
    );
    const resolvedAgain = compareFollowUp(
      PR,
      reopened.state,
      threads(
        t("T1", [c("a", "sam", "01T10:00"), c("b", "ana", "02T10:00")]),
        t("T2", [c("e", "sam", "01T10:30")], { isResolved: true }),
      ),
      undefined,
      NOW,
    );
    expect(resolvedAgain.events.map((e) => e.kind)).not.toContain("your-turn");
    // You answer; they answer back: a new round.
    const next = compareFollowUp(
      PR,
      resolvedAgain.state,
      threads(
        t("T1", [
          c("a", "sam", "01T10:00"),
          c("b", "ana", "02T10:00"),
          c("f", "sam", "03T10:00"),
          c("g", "ana", "03T11:00"),
        ]),
        t("T2", [c("e", "sam", "01T10:30")], { isResolved: true }),
      ),
      undefined,
      NOW,
    );
    expect(next.events.map((e) => e.kind)).toEqual(["reply", "your-turn"]);
  });

  it("tells a re-review request newer than the last one seen, without reading the threads", () => {
    const base = compareFollowUp(PR, undefined, threads(), undefined, NOW).state;
    const asked = compareFollowUp(PR, base, undefined, "2026-10-10T09:00:00.000Z", NOW);
    expect(asked.events).toMatchObject([
      { kind: "rereview", text: "ana asked you to review again", at: "2026-10-10T09:00:00.000Z" },
    ]);
    expect(compareFollowUp(PR, asked.state, undefined, "2026-10-10T09:00:00.000Z", NOW).events).toEqual([]);
    const noAuthor = compareFollowUp({ ...PR, author: undefined }, base, undefined, "2026-10-10T09:00:00.000Z", NOW);
    expect(noAuthor.events[0]?.text).toBe("You were asked to review again");
  });
});

describe("state helpers", () => {
  it("counts your threads, resolved ones and ones with a reply waiting", () => {
    const { state } = compareFollowUp(
      PR,
      undefined,
      threads(
        t("T1", [c("a", "sam", "01T10:00"), c("b", "ana", "02T10:00")]),
        t("T2", [c("e", "sam", "01T10:30")], { isResolved: true }),
        t("T3", [c("h", "sam", "01T11:00")]),
      ),
      undefined,
      NOW,
    );
    expect(stateCounts(state)).toEqual({ yourThreads: 3, resolved: 1, replied: 1 });
  });

  it("reads back only a state it wrote", () => {
    expect(parseState(undefined)).toBeUndefined();
    expect(parseState("{oops")).toBeUndefined();
    expect(parseState('{"version":2,"threads":{}}')).toBeUndefined();
    expect(parseState('{"version":1,"threads":{}}')).toEqual({ version: 1, threads: {} });
  });

  it("isn't your turn with no threads of yours", () => {
    expect(isYourTurn([])).toBe(false);
  });
});
