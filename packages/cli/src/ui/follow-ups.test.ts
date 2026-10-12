import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RankedQueue } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GitHub is faked: this is about the API's choices, not the check (core's tests cover that).
const github = vi.hoisted(() => ({ checks: [] as { global: string; queue: unknown[] }[], requests: 0 }));
vi.mock("@alden/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@alden/core")>();
  return {
    ...real,
    // The queue's check runs core's own (see refreshFollowUps), against a GitHub that has nothing to follow.
    createGitHubClient: () => ({
      graphql: async () => {
        github.requests++;
        return { viewer: { login: "me" }, search: { nodes: [] } };
      },
    }),
    checkFollowUps: async (_client: unknown, _store: unknown, options: { global: string; queue: unknown[] }) => {
      github.checks.push(options);
      return { followed: 0, read: 0, failed: 0, ended: 0, recorded: [] };
    },
  };
});

const { createFollowUpsApi } = await import("./follow-ups.js");
const { closeStores, openStore, setConfigValue } = await import("@alden/core");

let home: string;
const saved = process.env.ALDEN_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "alden-follow-ups-api-"));
  process.env.ALDEN_HOME = home;
  github.checks = [];
  github.requests = 0;
});
afterEach(() => {
  closeStores();
  if (saved === undefined) delete process.env.ALDEN_HOME;
  else process.env.ALDEN_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const signedIn = vi.fn(async () => ({ token: "t", source: "env" as const }));
const api = () =>
  createFollowUpsApi({
    cwd: home,
    signedIn,
    prRef: async (pr) => {
      const [repo, number] = pr.split("#") as [string, string];
      return { repo, number: Number(number) };
    },
  });

describe("follow-ups API", () => {
  it("checks at the global level with the last queue's re-review requests, and says whether to play a sound", async () => {
    const followUps = api();
    const row = (pr: number, followUp?: object) => ({
      pr: { repo: "acme/shop", number: pr, title: "T", url: "u", author: "ana", updatedAt: "2026-10-11T10:00:00Z" },
      ...(followUp ? { followUp } : {}),
    });
    await followUps.noteQueue({
      needsYou: [row(1, { pr: "acme/shop#1", rereviewRequestedAt: "2026-10-11T09:00:00.000Z" }), row(2)],
      fastTrack: [],
    } as unknown as RankedQueue);
    expect(await followUps.check()).toEqual({ notifications: [], sound: true });
    expect(github.checks).toMatchObject([
      {
        global: "your-turn",
        queue: [{ pr: { number: 1 }, followUp: { rereviewRequestedAt: "2026-10-11T09:00:00.000Z" } }],
      },
    ]);
  });

  it("asks GitHub nothing when every level is off", async () => {
    await setConfigValue("notifications.followUps", "off");
    const followUps = api();
    signedIn.mockClear();
    expect((await followUps.check()).notifications).toEqual([]);
    expect(signedIn).not.toHaveBeenCalled();
    // One PR you still want to hear about is enough to check.
    await followUps.setWatch("acme/shop#1", "rereview");
    await followUps.check();
    expect(github.checks).toHaveLength(1);
  });

  it("checks with a fresh queue, unless no PR could show news", async () => {
    const queue = { needsYou: [], fastTrack: [] } as unknown as RankedQueue;
    await api().refresh(queue);
    expect(github.requests).toBe(1);
    await setConfigValue("notifications.followUps", "off");
    await api().refresh(queue);
    expect(github.requests).toBe(1);
  });

  it("serves Your turn from what's stored, and marks a PR's news seen when you open it", async () => {
    const store = openStore();
    const event = {
      id: "e1",
      pr: "acme/shop#7",
      title: "Fix it",
      url: "https://github.com/acme/shop/pull/7",
      kind: "reply",
      at: "2026-10-11T10:00:00.000Z",
      text: "Ana replied to your comment on src/pay.ts:40",
      thread: "T1",
      by: "Ana",
    };
    store.run(
      "INSERT INTO follow_ups (pr_key, repo, number, checked_at, updated_at, state) VALUES (?, ?, ?, ?, ?, ?)",
      "acme/shop#7",
      "acme/shop",
      7,
      event.at,
      event.at,
      JSON.stringify({ version: 1, threads: {} }),
    );
    store.run(
      "INSERT INTO follow_up_events (id, pr_key, kind, at, event, notified) VALUES (?, ?, ?, ?, ?, 1)",
      "e1",
      "acme/shop#7",
      "reply",
      event.at,
      JSON.stringify(event),
    );
    const followUps = api();
    const empty = { schemaVersion: 1, needsYou: [], fastTrack: [], warnings: [] } as unknown as RankedQueue;
    const queue = await followUps.noteQueue(empty, { repos: [], orgs: [], ignore: [] });
    expect(queue.yourTurn).toMatchObject([
      { pr: "acme/shop#7", title: "Fix it", news: { text: "Ana replied to your comment", thread: "T1" } },
    ]);
    // Out of this machine's scope: not shown.
    expect((await followUps.noteQueue(empty, { repos: [], orgs: [], ignore: ["acme"] })).yourTurn).toEqual([]);
    expect(await followUps.seen("acme/shop#7")).toEqual({ seen: 1 });
    expect((await followUps.noteQueue(empty)).yourTurn).toEqual([]);
    // Served from the database alone.
    expect(github.requests).toBe(0);
  });

  it("sets, reads and clears a PR's own level", async () => {
    const followUps = api();
    expect(await followUps.watch("acme/shop#1")).toEqual({ pr: "acme/shop#1", level: "your-turn" });
    expect(await followUps.setWatch("acme/shop#1", "off")).toEqual({
      pr: "acme/shop#1",
      override: "off",
      level: "off",
    });
    expect(await followUps.setWatch("acme/shop#1", null)).toEqual({ pr: "acme/shop#1", level: "your-turn" });
    expect(openStore().all("SELECT * FROM pr_watch")).toEqual([]);
  });
});
