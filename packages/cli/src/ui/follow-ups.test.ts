import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RankedQueue } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GitHub is faked: this is about the API's choices, not the check (core's tests cover that).
const github = vi.hoisted(() => ({ checks: [] as { global: string; queue: unknown[] }[] }));
vi.mock("@alden/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@alden/core")>();
  return {
    ...real,
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
    followUps.noteQueue({
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
