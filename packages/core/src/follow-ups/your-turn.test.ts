import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FollowUpEvent, RankedPullRequest, RankedQueue } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitHubClient } from "../github/client.js";
import { type RawThread, THREADS_QUERY } from "../github/threads.js";
import { AldenStore } from "../store/db.js";
import { checkFollowUps } from "./check.js";
import { ackFollowUps, pendingFollowUps } from "./notifications.js";
import { setWatch } from "./watch.js";
import {
  markFollowUpsSeen,
  newsOf,
  newsText,
  refreshFollowUps,
  repoInScope,
  unseenNews,
  withYourTurn,
} from "./your-turn.js";

let home: string;
let store: AldenStore;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "alden-your-turn-"));
  store = AldenStore.open(join(home, "alden.db"));
});
afterEach(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 11, 12, minutes));

interface FakePr {
  repo: string;
  number: number;
  updatedAt: string;
  state?: "OPEN" | "CLOSED" | "MERGED";
  threads: RawThread[];
}

/** GitHub, as the check asks it: one request for the PRs you reviewed, and one per PR whose threads are read. */
function fakeGitHub(prs: FakePr[], options: { delayMs?: number } = {}) {
  const calls = { followed: 0, threads: 0 };
  const raw = (pr: FakePr) => ({
    number: pr.number,
    title: `PR ${pr.number}`,
    url: `https://github.com/${pr.repo}/pull/${pr.number}`,
    updatedAt: pr.updatedAt,
    state: pr.state ?? "OPEN",
    author: { login: "ana" },
    repository: { nameWithOwner: pr.repo },
  });
  const client = {
    graphql: async (query: string, variables: Record<string, unknown>) => {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (query === THREADS_QUERY) {
        calls.threads++;
        const pr = prs.find((p) => p.repo === `${variables.owner}/${variables.name}` && p.number === variables.number);
        return { repository: { pullRequest: pr ? { headRefOid: "h1", reviewThreads: { nodes: pr.threads } } : null } };
      }
      calls.followed++;
      const data: Record<string, unknown> = {
        viewer: { login: "sam" },
        search: { nodes: prs.filter((p) => (p.state ?? "OPEN") === "OPEN").map(raw) },
      };
      for (let i = 0; `o${i}` in variables; i++) {
        const pr = prs.find(
          (p) => p.repo === `${variables[`o${i}`]}/${variables[`n${i}`]}` && p.number === variables[`k${i}`],
        );
        data[`p${i}`] = { pullRequest: pr ? raw(pr) : null };
      }
      return data;
    },
  } as unknown as GitHubClient;
  return { client, calls };
}

const comment = (id: string, login: string, minute: number) => ({
  id,
  databaseId: null,
  author: { login },
  body: "text",
  createdAt: at(minute - 600).toISOString(),
  url: `https://github.com/acme/shop/pull/12#${id}`,
});

const thread = (id: string, comments: ReturnType<typeof comment>[], extra: Partial<RawThread> = {}): RawThread => ({
  id,
  path: "src/pay.ts",
  line: 40,
  startLine: null,
  originalLine: 40,
  diffSide: "RIGHT",
  isResolved: false,
  isOutdated: false,
  viewerCanReply: true,
  viewerCanResolve: true,
  comments: { nodes: comments },
  ...extra,
});

const check = (client: GitHubClient, minutes: number) =>
  checkFollowUps(client, store, { global: "every-reply", now: at(minutes) });

const emptyQueue = (rows: RankedPullRequest[] = []): RankedQueue => ({
  schemaVersion: 1,
  viewer: "sam",
  fetchedAt: at(0).toISOString(),
  needsYou: rows,
  fastTrack: [],
  warnings: [],
});

/** A PR you reviewed with two threads of yours, then Ana answers one and resolves the other. */
async function anaAnswers() {
  const pr: FakePr = {
    repo: "acme/shop",
    number: 12,
    updatedAt: "2026-10-11T10:00:00Z",
    threads: [thread("T1", [comment("a", "sam", 0)]), thread("T2", [comment("b", "sam", 0)], { line: 9 })],
  };
  const github = fakeGitHub([pr]);
  await check(github.client, 0);
  pr.updatedAt = "2026-10-11T12:30:00Z";
  pr.threads = [
    thread("T1", [comment("a", "sam", 0), comment("c", "ana", 20)]),
    thread("T2", [comment("b", "sam", 0)], { line: 9, isResolved: true, resolvedBy: { login: "ana" } }),
  ];
  await check(github.client, 40);
  return { pr, ...github };
}

describe("the news line", () => {
  it("counts threads, names who answered, and reads well alone", () => {
    expect(newsText({ who: ["Ana"], replies: 2, resolved: 1, outdated: 0 })).toBe(
      "Ana replied to 2 of your comments · 1 resolved",
    );
    expect(newsText({ who: ["Ana"], replies: 1, resolved: 0, outdated: 0 })).toBe("Ana replied to your comment");
    expect(newsText({ who: ["Ana", "Bo"], replies: 2, resolved: 0, outdated: 1 })).toBe(
      "Ana and Bo replied to 2 of your comments · 1 outdated by a push",
    );
    expect(newsText({ who: ["Ana", "Bo", "Cy"], replies: 3, resolved: 0, outdated: 0 })).toBe(
      "Ana and 2 others replied to 3 of your comments",
    );
    expect(newsText({ who: [], replies: 0, resolved: 1, outdated: 0 })).toBe("Your comment was resolved");
    expect(newsText({ who: [], replies: 0, resolved: 3, outdated: 1 })).toBe(
      "3 of your comments resolved · 1 outdated by a push",
    );
    expect(newsText({ who: [], replies: 0, resolved: 0, outdated: 2 })).toBe("A push outdated 2 of your comments");
  });

  it("counts a thread once however many replies it has, and leaves re-reviews to the queue row", () => {
    const event = (id: string, kind: FollowUpEvent["kind"], extra: Partial<FollowUpEvent> = {}): FollowUpEvent => ({
      id,
      pr: "acme/shop#12",
      title: "T",
      url: "u",
      kind,
      at: "2026-10-11T12:00:00.000Z",
      text: "Ana replied to your comment on src/pay.ts:40",
      ...extra,
    });
    const news = newsOf(
      [
        event("r1", "reply", { thread: "T1", by: "Ana" }),
        event("r2", "reply", { thread: "T1", by: "Bo", at: "2026-10-11T12:05:00.000Z" }),
        // Recorded before events said who: the text does.
        event("r3", "reply", { thread: "T2" }),
        event("q", "rereview", { text: "Ana asked you to review again" }),
      ],
      undefined,
    );
    expect(news).toMatchObject({
      text: "Ana and Bo replied to 2 of your comments",
      replies: 2,
      at: "2026-10-11T12:05:00.000Z",
      thread: "T1",
      events: ["r1", "r2", "r3"],
    });
    expect(newsOf([event("q", "rereview")], undefined)).toBeUndefined();
  });
});

describe("Your turn", () => {
  it("lists a PR you reviewed with what happened, until you open it, whether or not you were notified", async () => {
    await anaAnswers();
    const queue = withYourTurn(store, emptyQueue(), { global: "your-turn" });
    expect(queue.yourTurn).toEqual([
      {
        pr: "acme/shop#12",
        repo: "acme/shop",
        number: 12,
        title: "PR 12",
        url: "https://github.com/acme/shop/pull/12",
        news: expect.objectContaining({
          text: "ana replied to your comment · 1 resolved",
          replies: 1,
          resolved: 1,
          outdated: 0,
          thread: "T1",
        }),
      },
    ]);

    // The desktop app tells you, and acknowledges it: the group still has it.
    const told = pendingFollowUps(store, "every-reply");
    ackFollowUps(
      store,
      told.flatMap((n) => n.events),
    );
    expect(withYourTurn(store, emptyQueue(), { global: "your-turn" }).yourTurn).toHaveLength(1);

    // You open it: gone from the group.
    expect(markFollowUpsSeen(store, "Acme/Shop", 12)).toBeGreaterThan(0);
    expect(withYourTurn(store, emptyQueue(), { global: "your-turn" }).yourTurn).toEqual([]);
  });

  it("counts seeing it as being told: opened first, the desktop app doesn't notify it", async () => {
    await anaAnswers();
    markFollowUpsSeen(store, "acme/shop", 12);
    expect(pendingFollowUps(store, "every-reply")).toEqual([]);
  });

  it("puts a PR still in the queue on its own row instead, so it's never listed twice", async () => {
    await anaAnswers();
    const row = {
      pr: { repo: "acme/shop", number: 12 },
      followUp: { pr: "acme/shop#12", lastReviewedAt: at(0).toISOString(), yourThreads: 2, resolved: 0, replied: 0 },
    } as unknown as RankedPullRequest;
    const other = { pr: { repo: "acme/shop", number: 13 } } as unknown as RankedPullRequest;
    const queue = withYourTurn(store, emptyQueue([row, other]), { global: "your-turn" });
    expect(queue.yourTurn).toEqual([]);
    expect(queue.needsYou[0]?.followUp?.news?.text).toBe("ana replied to your comment · 1 resolved");
    expect(queue.needsYou[1]).toBe(other);
  });

  it("follows each PR's level: Off and Re-review only hide its news, a PR's own level wins", async () => {
    await anaAnswers();
    expect(withYourTurn(store, emptyQueue(), { global: "off" }).yourTurn).toEqual([]);
    expect(withYourTurn(store, emptyQueue(), { global: "rereview" }).yourTurn).toEqual([]);
    expect(withYourTurn(store, emptyQueue(), { global: "every-reply" }).yourTurn).toHaveLength(1);
    setWatch(store, "acme/shop", 12, "off");
    expect(withYourTurn(store, emptyQueue(), { global: "every-reply" }).yourTurn).toEqual([]);
    setWatch(store, "acme/shop", 12, "your-turn");
    expect(withYourTurn(store, emptyQueue(), { global: "off" }).yourTurn).toHaveLength(1);
  });

  it("drops a reply you've answered since, and a PR that was merged", async () => {
    const { pr, client } = await anaAnswers();
    // You answered Ana on GitHub; the resolve is still news.
    pr.updatedAt = "2026-10-11T13:30:00Z";
    pr.threads = [
      thread("T1", [comment("a", "sam", 0), comment("c", "ana", 20), comment("d", "sam", 80)]),
      thread("T2", [comment("b", "sam", 0)], { line: 9, isResolved: true, resolvedBy: { login: "ana" } }),
    ];
    await check(client, 90);
    expect(unseenNews(store, "your-turn").get("acme/shop#12")?.news.text).toBe("Your comment was resolved");

    pr.state = "MERGED";
    await check(client, 120);
    expect(withYourTurn(store, emptyQueue(), { global: "your-turn" }).yourTurn).toEqual([]);
  });

  it("keeps to the queue's scope", async () => {
    await anaAnswers();
    expect(withYourTurn(store, emptyQueue(), { global: "your-turn", scope: { orgs: ["other"] } }).yourTurn).toEqual([]);
    expect(repoInScope("acme/shop", {})).toBe(true);
    expect(repoInScope("Acme/Shop", { repos: ["acme/shop"] })).toBe(true);
    expect(repoInScope("acme/shop", { orgs: ["ACME"] })).toBe(true);
    expect(repoInScope("acme/shop", { orgs: ["acme"], ignore: ["acme/shop"] })).toBe(false);
    expect(repoInScope("acme/shop", { ignore: ["acme"] })).toBe(false);
  });
});

describe("refreshFollowUps", () => {
  it("asks GitHub nothing when no PR could show news, and nothing more when nothing changed", async () => {
    const pr: FakePr = {
      repo: "acme/shop",
      number: 12,
      updatedAt: "2026-10-11T10:00:00Z",
      threads: [thread("T1", [comment("a", "sam", 0)])],
    };
    const { client, calls } = fakeGitHub([pr]);
    expect(await refreshFollowUps(client, store, { global: "off" })).toBe("off");
    expect(calls).toEqual({ followed: 0, threads: 0 });

    expect(await refreshFollowUps(client, store, { global: "your-turn", now: at(0) })).toBe("checked");
    expect(calls).toEqual({ followed: 1, threads: 1 });
    // Within the minute: nothing asked at all.
    expect(
      await refreshFollowUps(client, store, { global: "your-turn", now: new Date(at(0).getTime() + 20_000) }),
    ).toBe("skipped");
    expect(calls).toEqual({ followed: 1, threads: 1 });
    // Later, nothing changed on GitHub: the one request that finds the PRs, no threads read.
    expect(await refreshFollowUps(client, store, { global: "your-turn", now: at(5) })).toBe("checked");
    expect(calls).toEqual({ followed: 2, threads: 1 });
  });

  it("waits only so long for a slow check, and never throws", async () => {
    const slow = fakeGitHub([], { delayMs: 200 });
    expect(await refreshFollowUps(slow.client, store, { global: "your-turn", waitMs: 10, now: at(0) })).toBe("pending");
    const broken = { graphql: async () => Promise.reject(new Error("offline")) } as unknown as GitHubClient;
    // The slow one is still running: a second check joins it rather than asking again.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await refreshFollowUps(broken, store, { global: "your-turn", now: at(10) })).toBe("failed");
  });
});
