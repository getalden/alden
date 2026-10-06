import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeStores, type ReviewQueue } from "@alden/core";
import type { PullRequestFacts } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRankingApi, type RankingApi } from "./rank.js";
import { startUiServer, type UiApi, type UiServer } from "./server.js";

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function facts(number: number, overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    repo: "acme/shop",
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/shop/pull/${number}`,
    author: `dev${number}`,
    authorIsBot: false,
    isDraft: false,
    createdAt: hoursAgo(2),
    updatedAt: hoursAgo(1),
    baseRef: "main",
    headRef: `dev/${number}`,
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

const queue: ReviewQueue = {
  viewer: "me",
  fetchedAt: hoursAgo(0),
  warnings: [],
  pullRequests: [
    facts(1, { labels: ["urgent"] }),
    facts(2, { request: { direct: true, teams: [], requestedAt: hoursAgo(80) } }),
    facts(3, { files: [{ path: "app/payments/charge.ts", additions: 3, deletions: 0 }] }),
    facts(4, { author: "dependabot[bot]", authorIsBot: true, stackedPrs: 1 }),
  ],
};

let home: string;
let saved: { home: string | undefined; track: string | undefined };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "alden-rank-"));
  saved = { home: process.env.ALDEN_HOME, track: process.env.DO_NOT_TRACK };
  process.env.ALDEN_HOME = home;
  process.env.DO_NOT_TRACK = "1";
});

afterEach(async () => {
  closeStores();
  if (saved.home === undefined) delete process.env.ALDEN_HOME;
  else process.env.ALDEN_HOME = saved.home;
  if (saved.track === undefined) delete process.env.DO_NOT_TRACK;
  await rm(home, { recursive: true, force: true });
});

const rankingApi = (fetchQueue: () => Promise<ReviewQueue> = async () => queue) =>
  createRankingApi({ cwd: home, desktop: true, queue: fetchQueue });

describe("Settings → Ranking", () => {
  it("loads the defaults, saves weights, rules and how many to brief, and loads them back", async () => {
    const api = rankingApi();
    const before = await api.state();
    expect(before).toMatchObject({ prepare: 3, background: true, settings: { waiting: 1, rules: [] } });
    expect(before.path).toBe(join(home, "config.toml"));

    const after = await api.save({
      weights: { waiting: 2, learned: 0 },
      rules: [{ when: { path: "payments/" }, then: "first" }],
      prepare: 5,
    });
    expect(after).toMatchObject({ prepare: 5, settings: { waiting: 2, learned: 0, size: 1 } });
    expect(after.settings.rules).toEqual([{ when: { path: "payments/" }, then: "first" }]);
    expect(await readFile(join(home, "config.toml"), "utf8")).toContain("[[queue.rank.rules]]");
  });

  it("refuses settings the schema refuses, as a 400 the UI shows", async () => {
    await expect(rankingApi().save({ prepare: 40 })).rejects.toMatchObject({ status: 400 });
    await expect(rankingApi().preview({ weights: { size: -1 } })).rejects.toMatchObject({ status: 400 });
  });

  it("previews the top five with unsaved settings, beside where each PR sits now", async () => {
    const api = rankingApi();
    const now = await api.preview({});
    expect(now.top.map((r) => r.pr)).toEqual(["acme/shop#1", "acme/shop#2", "acme/shop#4", "acme/shop#3"]);
    expect(now.top.map((r) => r.was)).toEqual([1, 2, 3, 4]);

    const trying = await api.preview({
      weights: { urgentLabel: 0 },
      rules: [
        { when: { path: "payments/" }, then: "first" },
        { when: { author: "bots" }, then: "last" },
      ],
    });
    expect(trying.top.map((r) => r.pr)).toEqual(["acme/shop#3", "acme/shop#2", "acme/shop#1", "acme/shop#4"]);
    expect(trying.top[0]).toMatchObject({ pinned: "first", was: 4 });
    expect(trying.top[0]?.reasons[0]).toBe("↑ your rule: payments/ first");
    expect(trying.top[0]?.breakdown.at(-1)).toEqual({
      signal: "rule",
      points: 0,
      text: "↑ your rule: payments/ first",
    });
    // Nothing was saved.
    expect((await api.state()).settings.rules).toEqual([]);
  });

  it("says why there's no preview when there's no queue to rank", async () => {
    const api = rankingApi(async () => {
      throw new Error("Not signed in to GitHub.");
    });
    expect(await api.preview({})).toEqual({
      fetchedAt: null,
      needsYou: 0,
      top: [],
      problem: "Not signed in to GitHub.",
    });
  });
});

describe("the ranking routes", () => {
  let ui: UiServer;
  let ranking: RankingApi;
  const TOKEN = "test-token-0123456789";

  beforeEach(async () => {
    ranking = rankingApi();
    ui = await startUiServer({ api: { ranking } as unknown as UiApi, token: TOKEN });
  });
  afterEach(() => ui.close());

  const call = (path: string, method = "GET", body?: unknown, token = TOKEN) =>
    new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: ui.port,
          path,
          method,
          headers: { Host: `127.0.0.1:${ui.port}`, "X-Alden-Token": token },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }));
        },
      );
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });

  it("needs the session token like every other call", async () => {
    expect((await call("/api/rank", "GET", undefined, "wrong-token-012345678")).status).toBe(401);
  });

  it("reads, saves and previews, and checks the body's shape", async () => {
    expect((await call("/api/rank")).json).toMatchObject({ prepare: 3 });
    const saved = await call("/api/rank", "PUT", { weights: { size: 0 }, prepare: 1 });
    expect(saved.json).toMatchObject({ prepare: 1, settings: { size: 0 } });
    const preview = await call("/api/rank/preview", "POST", { rules: [{ when: { label: "urgent" }, then: "last" }] });
    expect((preview.json.top as { pr: string }[]).at(-1)?.pr).toBe("acme/shop#1");

    expect((await call("/api/rank", "PUT", { weights: { size: "lots" } })).status).toBe(400);
    expect((await call("/api/rank", "PUT", { rules: { when: {} } })).status).toBe(400);
    expect((await call("/api/rank", "PUT", { colour: "red" })).status).toBe(400);
    expect((await call("/api/rank", "PUT", { rules: [{ when: {}, then: "first" }] })).json.error).toMatch(
      /at least one condition/,
    );
    expect((await call("/api/rank/preview", "POST", { weights: { size: null } })).status).toBe(400);
  });
});
