import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Briefing, BriefingFreshness } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GitHub, the queue and the review itself are faked: this is about when a background briefing is served or redone.
const github = vi.hoisted(() => ({
  freshness: [] as (BriefingFreshness | Error)[],
  checks: 0,
  reviews: 0,
}));
const PR = {
  repo: "acme/app",
  number: 7,
  url: "https://github.com/acme/app/pull/7",
  updatedAt: "2026-10-06T09:00:00Z",
};

vi.mock("@alden/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@alden/core")>();
  const ranked = {
    needsYou: [{ pr: { ...PR, title: "T", isDraft: false }, waitingOnAuthor: false }],
    fastTrack: [],
  };
  return {
    ...real,
    resolveToken: async () => ({ token: "t", source: "env" }),
    fetchReviewQueue: async () => ({}),
    rankQueue: () => ranked,
    queueRows: () => [{ repo: PR.repo, number: PR.number, url: PR.url, updatedAt: PR.updatedAt }],
    queueEvent: () => ({}),
    track: async () => {},
    backgroundModelAllowed: async () => false,
    // The follow-up check with a fresh queue has its own tests (follow-ups.test.ts, and core's).
    refreshFollowUps: async () => "checked",
    reviewPullRequest: async (): Promise<Briefing> => {
      github.reviews++;
      return {
        schemaVersion: 1,
        target: {
          kind: "pr",
          repo: PR.repo,
          number: PR.number,
          url: PR.url,
          title: "T",
          author: "sam",
          baseRef: "main",
          headRef: "feature",
          headSha: "h1",
          baseSha: "b1",
          graphFrom: "merge",
        },
        generatedAt: "2026-10-06T09:05:00.000Z",
        summary: { files: 0, additions: 0, deletions: 0, reviewableAdditions: 0, reviewableDeletions: 0 },
        files: [],
        checks: [],
        needsYourEyes: [],
        notChecked: [],
      };
    },
    checkFreshness: async () => {
      github.checks++;
      const next = github.freshness.shift() ?? { state: "fresh" };
      if (next instanceof Error) throw next;
      return next;
    },
  };
});
vi.mock("../learning.js", () => ({
  learningFor: async () => undefined,
  learningForQueue: async () => () => undefined,
  noteOpened: () => {},
}));

const { createUiApi } = await import("./api.js");
const { closeStores, configureTelemetry, openStore } = await import("@alden/core");

let home: string;
let now: number;
const saved = { home: process.env.ALDEN_HOME, track: process.env.DO_NOT_TRACK };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "alden-prepared-"));
  process.env.ALDEN_HOME = home;
  process.env.DO_NOT_TRACK = "1";
  Object.assign(github, { freshness: [], checks: 0, reviews: 0 });
  now = Date.parse("2026-10-06T09:05:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
  closeStores();
  process.env.ALDEN_HOME = saved.home;
  if (saved.home === undefined) delete process.env.ALDEN_HOME;
  if (saved.track === undefined) delete process.env.DO_NOT_TRACK;
  rmSync(home, { recursive: true, force: true });
});

const key = `${PR.repo}#${PR.number}`;

describe("background briefings and staleness", () => {
  it("serves a prepared briefing only while GitHub says it's fresh, and prepares it again once it isn't", async () => {
    const api = createUiApi({ version: "test", cwd: home, desktop: true });
    expect(await api.prepareNext()).toMatchObject({ prepared: { pr: key } });
    expect(await api.prepareNext()).toEqual({ prepared: null, reason: "up to date" });
    expect(github.reviews).toBe(1);

    expect(await api.prepared(key)).toMatchObject({ briefing: { target: { headSha: "h1" } } });
    // main moved on: the queue's update time doesn't change, but the briefing is no longer served.
    github.freshness.push({ state: "base_moved", baseRef: "main", commits: 4 });
    expect(await api.prepared(key)).toBeNull();
    expect(github.checks).toBe(2);

    expect(await api.prepareNext()).toMatchObject({ prepared: { pr: key } });
    expect(github.reviews).toBe(2);
  });

  it("rechecks prepared briefings while you're away, at most every few minutes, and redoes stale ones", async () => {
    const api = createUiApi({ version: "test", cwd: home, desktop: true });
    await api.prepareNext();
    now += 60_000;
    await api.prepareNext();
    expect(github.checks).toBe(0);

    now += 5 * 60_000;
    github.freshness.push({ state: "fresh" });
    expect(await api.prepareNext()).toEqual({ prepared: null, reason: "up to date" });
    expect(github.checks).toBe(1);

    now += 5 * 60_000;
    github.freshness.push({ state: "pr_changed", commits: 2 });
    expect(await api.prepareNext()).toMatchObject({ prepared: { pr: key } });
    expect([github.checks, github.reviews]).toEqual([2, 2]);
  });

  it("falls back to the last queue's update time when GitHub can't be asked", async () => {
    const api = createUiApi({ version: "test", cwd: home, desktop: true });
    await api.prepareNext();
    github.freshness.push(new Error("offline"));
    expect(await api.prepared(key)).toMatchObject({ briefing: { target: { headSha: "h1" } } });
  });

  it("times a review from when you read the briefing, not when it was prepared in the background", async () => {
    // The desktop app's server says where it runs, as `alden ui --json` does.
    configureTelemetry({ version: "test", surface: "desktop" });
    const api = createUiApi({ version: "test", cwd: home, desktop: true });
    const sessions = () =>
      openStore().all<{ pr_key: string; surface: string; ui: number }>(
        "SELECT pr_key, surface, ui FROM review_sessions",
      );
    await api.prepareNext();
    expect(sessions()).toEqual([]);
    expect(await api.reportActive({ pr: key, activeMs: 10_000 })).toEqual({ counted: false });

    await api.prepared(key);
    expect(sessions()).toEqual([{ pr_key: "acme/app#7", surface: "desktop", ui: 1 }]);
    expect(await api.reportActive({ pr: key, activeMs: 10_000 })).toEqual({ counted: true });
    // Briefed again in the UI: the same review.
    await api.review({ pr: key, llm: false, graph: false }, () => {});
    expect(sessions()).toHaveLength(1);
    expect(openStore().get<{ active_ms: number }>("SELECT active_ms FROM review_sessions")?.active_ms).toBe(10_000);

    // Off: nothing more is counted.
    await api.setConfig("stats.reviewTime", "false");
    expect(await api.reportActive({ pr: key, activeMs: 10_000 })).toEqual({ counted: false });
    expect(await api.reviewTime()).toMatchObject({ enabled: false, horizonHours: 72 });
  });
});
