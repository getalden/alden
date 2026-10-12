import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AldenConfigSchema, type PullRequestFacts } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReviewQueue } from "../github/queue.js";
import { queueRows, type RankedQueue, rankQueue } from "../queue/rank.js";
import { type AldenStore, openStore } from "../store/db.js";
import { type Learning, loadLearning, OPEN_BOOST, recordOpen, recordReaction } from "./learn.js";

/**
 * End to end, through the real store and learning code: a reviewer works a queue of people's, Dependabot's and AI
 * agents' PRs over a few days, and the next queue says what they learned, as docs/queue.md ("Bots and AI agents") and
 * docs/memory.md describe it. Roadmap issue #6.
 */
const REPO = "acme/shop";
const VIEWER = "me";
const config = AldenConfigSchema.parse({}).queue;
const day = (d: number, hour = 9) => new Date(Date.UTC(2026, 9, d, hour));

/** A PR waiting on you since `hoursWaiting` before `now`: one changed source file, CI running. */
function pr(number: number, now: Date, over: Partial<PullRequestFacts> & { hoursWaiting?: number }): PullRequestFacts {
  const { hoursWaiting = 30, ...rest } = over;
  const since = new Date(now.getTime() - hoursWaiting * 3_600_000).toISOString();
  return {
    repo: REPO,
    number,
    title: `Change ${number}`,
    url: `https://github.com/${REPO}/pull/${number}`,
    author: "sam",
    authorIsBot: false,
    isDraft: false,
    createdAt: since,
    updatedAt: since,
    baseRef: "main",
    headRef: `change-${number}`,
    additions: 40,
    deletions: 10,
    changedFiles: 1,
    files: [{ path: "src/cart.ts", additions: 40, deletions: 10 }],
    filesTruncated: false,
    labels: [],
    assignees: [],
    ci: "pending",
    mergeable: "mergeable",
    reviews: [],
    request: { direct: true, teams: [], requestedAt: since },
    codeownedFiles: [],
    stackedPrs: 0,
    ...rest,
  };
}

const person = (login: string) => ({ author: login });
// A green patch bump: fast-track, so passing it by to open other PRs says nothing about them.
const dependabot = {
  author: "dependabot",
  authorIsBot: true,
  ci: "success" as const,
  title: "Bump lodash from 4.17.20 to 4.17.21 in /web",
  files: [
    { path: "web/package.json", additions: 1, deletions: 1 },
    { path: "web/pnpm-lock.yaml", additions: 8, deletions: 8 },
  ],
};
const renovate = { author: "renovate", authorIsBot: true, title: "Update actions/checkout to v5" };
// Claude's own GitHub app, a little newer than the rest, so ranked below the people's PRs before anything is learned.
const claudeApp = { author: "claude", authorIsBot: true, hoursWaiting: 2 };
// A person's PR carrying Claude Code's footer in its description: Claude's, and theirs.
const claudeMarked = (login: string) => ({
  author: login,
  hoursWaiting: 2,
  agentMarker: { agent: "claude", in: "description" as const },
});

const queueOf = (now: Date, pullRequests: PullRequestFacts[]): ReviewQueue => ({
  viewer: VIEWER,
  fetchedAt: now.toISOString(),
  pullRequests,
  warnings: [],
});

const all = (ranked: RankedQueue) => [...ranked.needsYou, ...ranked.fastTrack];
const row = (ranked: RankedQueue, number: number) => all(ranked).find((r) => r.pr.number === number);
const reasonsOf = (ranked: RankedQueue, number: number) => row(ranked, number)?.reasons ?? [];
const position = (ranked: RankedQueue, number: number) => ranked.needsYou.findIndex((r) => r.pr.number === number);

let dir: string;
let store: AldenStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alden-authors-"));
  store = openStore(join(dir, "alden.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * One morning: the queue as ranked with what's learned so far, then the reviewer's opens (in order) and reactions,
 * recorded the way the UI and `alden open` record them.
 */
async function morning(
  now: Date,
  prs: PullRequestFacts[],
  work: { open: number[]; down?: number[]; up?: number[] },
): Promise<Learning> {
  const learning = await loadLearning(store, REPO, now);
  const ranked = rankQueue(queueOf(now, prs), config, now.getTime(), () => learning);
  const rows = queueRows(ranked, config);
  const find = (number: number) => rows.find((r) => r.number === number) as (typeof rows)[number];
  for (const [i, number] of work.open.entries()) {
    recordOpen(store, rows, find(number), "ui", new Date(now.getTime() + i * 60_000));
  }
  for (const number of work.down ?? []) recordReaction(store, find(number), "down", find(number).updatedAt ?? "", now);
  for (const number of work.up ?? []) recordReaction(store, find(number), "up", find(number).updatedAt ?? "", now);
  return learning;
}

describe("learning from bot and AI-agent authors, end to end", () => {
  it("learns you skip Dependabot and open Claude's PRs first, from the app or a marked PR, and not from one-offs", async () => {
    // Day 1: Claude's app PR opened first, past the people's; a Renovate PR opened next, once; Dependabot's marked not
    // useful; and one of Lee's PRs marked useful, once.
    await morning(
      day(1),
      [
        pr(11, day(1), person("sam")),
        pr(12, day(1), person("ana")),
        pr(13, day(1), person("lee")),
        pr(14, day(1), dependabot),
        pr(15, day(1), claudeApp),
        pr(16, day(1), renovate),
      ],
      { open: [15, 16, 11, 12, 13], down: [14], up: [13] },
    );
    // Day 2: the same again, without the one-offs.
    const afterTwo = await morning(
      day(2),
      [
        pr(21, day(2), person("sam")),
        pr(22, day(2), person("ana")),
        pr(23, day(2), person("lee")),
        pr(24, day(2), dependabot),
        pr(25, day(2), claudeApp),
      ],
      { open: [25, 21, 22, 23], down: [24] },
    );
    // Two mornings aren't a habit yet.
    expect(afterTwo.queue).toEqual([]);

    // Day 3: Claude's work comes as Ana's PR with Claude Code's footer, and is opened first too.
    await morning(
      day(3),
      [
        pr(31, day(3), person("sam")),
        pr(32, day(3), person("lee")),
        pr(34, day(3), dependabot),
        pr(35, day(3), claudeMarked("ana")),
      ],
      { open: [35, 31, 32], down: [34] },
    );

    // Day 4's queue: one PR of each kind, and a fresh PR from each of the people.
    const now = day(4);
    const learning = await loadLearning(store, REPO, now);
    const lessons = learning.queue.map((l) => l.id);
    expect(lessons).toContain("queue:author:agent:claude:up");
    expect(lessons).toContain("queue:author:bot:dependabot:down");
    // The marked PR counted for Claude, and for Ana, who opened it.
    expect(learning.queueTallies.get("author:agent:claude")).toMatchObject({ opens: 3, jumps: 3 });
    expect(learning.queueTallies.get("author:ana")).toMatchObject({ opens: 3, jumps: 1 });
    // One-offs teach nothing: one Renovate PR opened ahead, one of Lee's marked useful.
    expect(lessons.filter((id) => id.includes("renovate") || id.includes("author:lee"))).toEqual([]);
    // Nor does opening the people's PRs in order.
    expect(lessons.filter((id) => /people|area:src|author:(sam|ana):/.test(id))).toEqual([]);

    const prs = [
      pr(41, now, person("sam")),
      pr(42, now, person("ana")),
      pr(43, now, person("lee")),
      pr(44, now, dependabot),
      // Waiting as long as the people's, so only what's learned tells them apart.
      pr(45, now, { ...claudeApp, hoursWaiting: 30 }),
      pr(46, now, { ...claudeMarked("kim"), hoursWaiting: 30 }),
      pr(47, now, renovate),
    ];
    const before = rankQueue(queueOf(now, prs), config, now.getTime());
    const after = rankQueue(queueOf(now, prs), config, now.getTime(), () => learning);

    // Claude's PRs, from its app or a person's PR with its marker, rank higher and say why.
    const people = [41, 42, 43];
    for (const number of [45, 46]) {
      expect(row(before, number)?.score.total).toBe(row(before, 41)?.score.total);
      expect(row(after, number)?.score.learned).toBe(OPEN_BOOST);
      expect(row(after, number)?.score.total).toBe((row(before, number)?.score.total ?? 0) + OPEN_BOOST);
      expect(reasonsOf(after, number)).toContain("ranked higher: you usually open Claude PRs first");
      for (const other of people) expect(position(after, number)).toBeLessThan(position(after, other));
    }
    expect(reasonsOf(after, 46)).toContain("by Claude (from its description)");
    expect(reasonsOf(after, 45).some((r) => r.startsWith("by Claude"))).toBe(false);

    // Dependabot's rank lower in their lane, and say why: who wrote it leads the reason, and what it touches (web/,
    // dependencies) adds to it, up to the cap.
    expect(row(after, 44)?.lane).toBe("fast-track");
    expect(row(after, 44)?.score.learned).toBe(-2 * OPEN_BOOST);
    expect(reasonsOf(after, 44)).toContain("ranked lower: you usually skip Dependabot PRs (3 marked not useful)");

    // Nothing learned about Renovate itself: it ranks as a bot PR at most, never "Renovate PRs".
    expect(reasonsOf(after, 47).join(" ")).not.toMatch(/Renovate/);
    // People's PRs carry no learned reason.
    for (const number of [41, 42, 43]) {
      expect(reasonsOf(after, number).filter((r) => r.startsWith("ranked "))).toEqual([]);
    }
  });
});
