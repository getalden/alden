import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FollowUpSummary, RankedQueue } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitHubClient } from "../github/client.js";
import { rememberSentComments } from "../github/outcomes.js";
import { type RawThread, THREADS_QUERY } from "../github/threads.js";
import { AldenStore } from "../store/db.js";
import { checkFollowUps, followedSearch } from "./check.js";
import { ackFollowUps, fillFollowUpCounts, notificationText, pendingFollowUps } from "./notifications.js";
import { listWatches, setWatch, watchOverride } from "./watch.js";

let home: string;
let store: AldenStore;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "alden-follow-ups-"));
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

/** GitHub, as far as the check asks it: the followed-PRs request (search and lookups) and each PR's threads. */
function fakeGitHub(prs: FakePr[], search: FakePr[] = prs) {
  const calls = { followed: 0, threads: [] as string[], variables: [] as Record<string, unknown>[] };
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
      if (query === THREADS_QUERY) {
        const pr = prs.find((p) => p.repo === `${variables.owner}/${variables.name}` && p.number === variables.number);
        calls.threads.push(`${variables.owner}/${variables.name}#${variables.number}`);
        return {
          repository: { pullRequest: pr ? { headRefOid: "h1", reviewThreads: { nodes: pr.threads } } : null },
        };
      }
      calls.followed++;
      calls.variables.push(variables);
      const data: Record<string, unknown> = {
        viewer: { login: "sam" },
        search: { nodes: search.map(raw) },
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

const check = (client: GitHubClient, minutes: number, extra: Partial<Parameters<typeof checkFollowUps>[2]> = {}) =>
  checkFollowUps(client, store, { global: "your-turn", now: at(minutes), ...extra });

describe("checkFollowUps", () => {
  it("searches for open PRs you reviewed in the last 14 days", () => {
    expect(followedSearch(at(0))).toBe("is:pr is:open archived:false reviewed-by:@me updated:>=2026-09-27");
  });

  it("takes a baseline first, then reads a PR again only when its updatedAt moved", async () => {
    const pr: FakePr = {
      repo: "acme/shop",
      number: 12,
      updatedAt: "2026-10-11T10:00:00Z",
      threads: [thread("T1", [comment("a", "sam", 0)])],
    };
    const { client, calls } = fakeGitHub([pr]);
    const first = await check(client, 0);
    expect(first).toMatchObject({ followed: 1, read: 1, recorded: [] });
    expect(calls.threads).toEqual(["acme/shop#12"]);

    // Nothing changed on GitHub: one request to find the PRs, none for threads.
    const quiet = await check(client, 5);
    expect(quiet).toMatchObject({ followed: 1, read: 0, recorded: [] });
    expect(calls).toMatchObject({ followed: 2, threads: ["acme/shop#12"] });

    pr.updatedAt = "2026-10-11T12:30:00Z";
    pr.threads = [thread("T1", [comment("a", "sam", 0), comment("b", "bo", 20)])];
    const moved = await check(client, 40);
    expect(moved.read).toBe(1);
    expect(moved.recorded.map((e) => e.kind)).toEqual(["reply", "your-turn"]);
  });

  it("asks GitHub at most once a minute", async () => {
    const { client, calls } = fakeGitHub([]);
    await check(client, 0);
    const again = await checkFollowUps(client, store, { global: "your-turn", now: new Date(at(0).getTime() + 30_000) });
    expect(again.skipped).toBe(true);
    expect(calls.followed).toBe(1);
    await check(client, 2);
    expect(calls.followed).toBe(2);
  });

  it("records events below a PR's level as already told, and the rest for the desktop app", async () => {
    const pr: FakePr = {
      repo: "acme/shop",
      number: 12,
      updatedAt: "2026-10-11T10:00:00Z",
      threads: [thread("T1", [comment("a", "sam", 0)]), thread("T2", [comment("c", "sam", 1)])],
    };
    const { client } = fakeGitHub([pr]);
    await check(client, 0);
    pr.updatedAt = "2026-10-11T12:30:00Z";
    pr.threads = [
      thread("T1", [comment("a", "sam", 0), comment("b", "bo", 20)]),
      thread("T2", [comment("c", "sam", 1)]),
    ];
    const result = await check(client, 40);
    expect(result.recorded.map((e) => e.kind)).toEqual(["reply"]);
    // At "your-turn", a reply alone isn't worth a notification, and won't become one later.
    expect(pendingFollowUps(store, "every-reply")).toEqual([]);

    setWatch(store, "acme/shop", 12, "every-reply", at(41));
    pr.updatedAt = "2026-10-11T12:50:00Z";
    pr.threads = [
      thread("T1", [comment("a", "sam", 0), comment("b", "bo", 20), comment("d", "ana", 45)]),
      thread("T2", [comment("c", "sam", 1)], { isResolved: true }),
    ];
    await check(client, 60);
    const [notification, ...rest] = pendingFollowUps(store, "your-turn");
    expect(rest).toEqual([]);
    expect(notification).toMatchObject({
      pr: "acme/shop#12",
      title: "PR 12",
      url: "https://github.com/acme/shop/pull/12",
      text: "1 reply, 1 resolved · your turn",
    });
    expect(notification?.events).toHaveLength(3);
    expect(ackFollowUps(store, notification?.events ?? [])).toBe(3);
    expect(pendingFollowUps(store, "every-reply")).toEqual([]);
  });

  it("tells a re-review request from the queue without reading the PR again", async () => {
    const pr: FakePr = { repo: "acme/shop", number: 12, updatedAt: "2026-10-11T10:00:00Z", threads: [] };
    const { client, calls } = fakeGitHub([pr], []);
    const row = (rereviewRequestedAt?: string) => ({
      pr: { ...pr, title: "Charge tax", url: "https://github.com/acme/shop/pull/12", author: "ana" },
      followUp: rereviewRequestedAt ? { rereviewRequestedAt } : {},
    });
    await check(client, 0, { queue: [row()] });
    await check(client, 5, { queue: [row("2026-10-11T09:00:00.000Z")] });
    expect(calls.threads).toEqual(["acme/shop#12"]);
    expect(pendingFollowUps(store, "rereview")).toMatchObject([
      { pr: "acme/shop#12", title: "Charge tax", text: "ana asked you to review again" },
    ]);
  });

  it("follows the PRs you sent comments on and set a level for, and stops when they're merged or closed", async () => {
    rememberSentComments(
      store,
      { repo: "acme/shop", number: 7, reviewId: 1, headSha: "h0", sentAt: at(0).toISOString() },
      [{ path: "a.ts", line: 1, side: "RIGHT" }],
    );
    setWatch(store, "acme/web", 3, "off", at(0));
    const shop: FakePr = { repo: "acme/shop", number: 7, updatedAt: "2026-10-11T10:00:00Z", threads: [] };
    const web: FakePr = { repo: "acme/web", number: 3, updatedAt: "2026-10-11T10:00:00Z", threads: [] };
    const { client, calls } = fakeGitHub([shop, web], []);
    const first = await check(client, 0);
    expect(first.followed).toBe(2);
    expect(calls.variables[0]).toMatchObject({ o0: "acme", n0: "web", k0: 3, o1: "acme", n1: "shop", k1: 7 });

    web.state = "MERGED";
    const second = await check(client, 5);
    expect(second).toMatchObject({ followed: 1, ended: 1 });
    expect(watchOverride(store, "acme/web", 3)).toBeUndefined();
    expect(listWatches(store)).toEqual([]);
    expect(store.get("SELECT * FROM follow_ups WHERE pr_key = 'acme/web#3'")).toBeUndefined();
  });

  it("tries a PR whose threads couldn't be read again next time", async () => {
    const pr: FakePr = { repo: "acme/shop", number: 12, updatedAt: "2026-10-11T10:00:00Z", threads: [] };
    const { client, calls } = fakeGitHub([pr]);
    const failing = {
      graphql: async (query: string, variables: Record<string, unknown>) => {
        if (query === THREADS_QUERY) throw new Error("502");
        return client.graphql(query, variables);
      },
    } as unknown as GitHubClient;
    expect(await check(failing, 0)).toMatchObject({ failed: 1, read: 0 });
    expect(await check(client, 5)).toMatchObject({ failed: 0, read: 1 });
    expect(calls.threads).toEqual(["acme/shop#12"]);
  });
});

describe("follow-up counts and text", () => {
  it("fills a queue row's counts from the last check", async () => {
    const pr: FakePr = {
      repo: "acme/shop",
      number: 12,
      updatedAt: "2026-10-11T10:00:00Z",
      threads: [
        thread("T1", [comment("a", "sam", 0), comment("b", "bo", 20)]),
        thread("T2", [comment("c", "sam", 1)], { isResolved: true }),
        thread("T3", [comment("e", "sam", 2)]),
      ],
    };
    await check(fakeGitHub([pr]).client, 0);
    const summary: FollowUpSummary = {
      pr: "acme/shop#12",
      lastReviewedAt: at(0).toISOString(),
      yourThreads: 0,
      resolved: 0,
      replied: 0,
    };
    const queue = {
      needsYou: [{ followUp: summary }, {}],
      fastTrack: [{ followUp: { ...summary, pr: "acme/shop#99" } }],
    } as unknown as RankedQueue;
    const filled = fillFollowUpCounts(store, queue);
    expect(filled.needsYou[0]?.followUp).toMatchObject({ yourThreads: 3, resolved: 1, replied: 1 });
    expect(filled.needsYou[1]).toEqual({});
    expect(filled.fastTrack[0]?.followUp).toMatchObject({ yourThreads: 0 });
  });

  it("words a notification from its events", () => {
    const base = { pr: "a/b#1", title: "T", url: "u", at: at(0).toISOString() };
    const e = (kind: "reply" | "resolved" | "outdated" | "rereview" | "your-turn", text: string = kind) => ({
      ...base,
      id: `${kind}${Math.random()}`,
      kind,
      text,
    });
    expect(notificationText([e("reply", "ana replied to your comment on a.ts:1")])).toBe(
      "ana replied to your comment on a.ts:1",
    );
    expect(notificationText([e("reply"), e("reply"), e("resolved")])).toBe("2 replies, 1 resolved");
    expect(notificationText([e("rereview", "Ana asked you to review again"), e("your-turn")])).toBe(
      "Ana asked you to review again · your turn",
    );
    expect(notificationText([e("resolved"), e("your-turn")])).toBe("1 resolved · your turn");
    expect(notificationText([e("outdated"), e("outdated")])).toBe("2 outdated by a push");
  });
});
