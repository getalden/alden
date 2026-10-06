import { AldenConfigSchema, type PullRequestFacts, type RankRule } from "@alden/schema";
import { describe, expect, it } from "vitest";
import type { Learning } from "../learn/learn.js";
import { rankPullRequest, rankQueue } from "./rank.js";
import { applyRules, describeWhen, pathGlobs, ruleMatches, ruleReason } from "./rules.js";

const NOW = Date.parse("2026-09-28T18:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function facts(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    repo: "acme/shop",
    number: 1,
    title: "Change something",
    url: "https://github.com/acme/shop/pull/1",
    author: "sam",
    authorIsBot: false,
    isDraft: false,
    createdAt: hoursAgo(2),
    updatedAt: hoursAgo(1),
    baseRef: "main",
    headRef: "sam/change",
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

/** The queue config with `[queue.rank]` set as a user would write it. */
const configWith = (rank: Record<string, unknown>) => AldenConfigSchema.parse({ queue: { rank } }).queue;
const rule = (r: Partial<RankRule> & Pick<RankRule, "when" | "then">): RankRule => r as RankRule;

describe("rule conditions", () => {
  it("reads a plain path as that folder or file anywhere, and a glob as a glob", () => {
    expect(pathGlobs("payments/")).toEqual(["payments", "payments/**", "**/payments", "**/payments/**"]);
    expect(pathGlobs("src/**/*.sql")).toEqual(["src/**/*.sql"]);
    const pr = facts({ files: [{ path: "app/Payments/Charge.php", additions: 1, deletions: 0 }] });
    expect(ruleMatches(rule({ when: { path: "payments/" }, then: "first" }), pr)).toBe(true);
    expect(ruleMatches(rule({ when: { path: "billing/" }, then: "first" }), pr)).toBe(false);
    expect(ruleMatches(rule({ when: { path: "**/*.php" }, then: "first" }), pr)).toBe(true);
  });

  it("matches labels in any case, titles by what they contain, repos by name or organisation, base by glob", () => {
    const pr = facts({ labels: ["Security"], title: "Fix the CSV export", baseRef: "release/2.1" });
    const when = (w: RankRule["when"]) => ruleMatches(rule({ when: w, then: "boost" }), pr);
    expect(when({ label: "security" })).toBe(true);
    expect(when({ title: "csv" })).toBe(true);
    expect(when({ repo: "acme" })).toBe(true);
    expect(when({ repo: "acme/shop" })).toBe(true);
    expect(when({ repo: "acme/shopfront" })).toBe(false);
    expect(when({ base: "release/*" })).toBe(true);
    expect(when({ base: "main" })).toBe(false);
    // Every condition must hold.
    expect(when({ label: "security", base: "main" })).toBe(false);
  });

  it("matches authors by login, or as people, bots and AI agents, the way learning classifies them", () => {
    const bot = facts({ author: "dependabot[bot]", authorIsBot: true });
    const agent = facts({ author: "Copilot", authorIsBot: true });
    const viaAgent = facts({ author: "lee", headRef: "claude/fix-login" });
    const person = facts({ author: "Sam" });
    const matches = (author: string, pr: PullRequestFacts) => ruleMatches(rule({ when: { author }, then: "last" }), pr);
    expect(matches("bots", bot)).toBe(true);
    expect(matches("dependabot", bot)).toBe(true);
    expect(matches("agents", agent)).toBe(true);
    expect(matches("bots", agent)).toBe(false);
    expect(matches("copilot", agent)).toBe(true);
    expect(matches("agents", viaAgent)).toBe(true);
    expect(matches("claude", viaAgent)).toBe(true);
    expect(matches("@lee", viaAgent)).toBe(true);
    expect(matches("people", person)).toBe(true);
    expect(matches("people", bot)).toBe(false);
    expect(matches("sam", person)).toBe(true);
  });

  it("says what it matched on the row", () => {
    expect(describeWhen({ path: "payments/" })).toBe("payments/");
    expect(describeWhen({ author: "bots", base: "main" })).toBe("bots and into main");
    expect(ruleReason(rule({ when: { path: "payments/" }, then: "first" }))).toBe("↑ your rule: payments/ first");
    expect(ruleReason(rule({ when: { author: "agents" }, then: "last" }))).toBe("↓ your rule: AI agents last");
    expect(ruleReason(rule({ when: { label: "security" }, then: "boost" }))).toBe("↑ your rule: labelled security +5");
    expect(ruleReason(rule({ when: { title: "wip" }, then: "lower", by: 2, name: "WIP" }))).toBe("↓ your rule: WIP −2");
  });

  it("lets the first matching first or last rule decide, and adds every boost and lower", () => {
    const pr = facts({ labels: ["security"] });
    const applied = applyRules(
      [
        rule({ when: { label: "security" }, then: "boost" }),
        rule({ when: { repo: "acme" }, then: "last" }),
        rule({ when: { author: "sam" }, then: "first" }),
        rule({ when: { title: "change" }, then: "lower", by: 2 }),
      ],
      pr,
    );
    expect(applied.pinned).toBe("last");
    expect(applied.points).toBe(3);
    expect(applied.reasons).toEqual([
      "↑ your rule: labelled security +5",
      "↓ your rule: acme last",
      '↓ your rule: "change" in title −2',
    ]);
  });
});

describe("rules in the queue", () => {
  const queue = (prs: PullRequestFacts[]) => ({
    viewer: "me",
    fetchedAt: hoursAgo(0),
    warnings: [],
    pullRequests: prs,
  });

  it("puts a first rule's PRs above everything else in their lane, ordered among themselves by score", () => {
    const prs = [
      facts({ number: 1, labels: ["urgent"], stackedPrs: 2 }),
      facts({ number: 2, files: [{ path: "payments/charge.ts", additions: 5, deletions: 0 }] }),
      facts({
        number: 3,
        files: [{ path: "payments/refund.ts", additions: 5, deletions: 0 }],
        request: { direct: true, teams: [], requestedAt: hoursAgo(80) },
      }),
      facts({ number: 4, author: "renovate[bot]", authorIsBot: true, stackedPrs: 3 }),
    ];
    const config = configWith({
      rules: [
        { when: { path: "payments/" }, then: "first" },
        { when: { author: "bots" }, then: "last" },
      ],
    });
    const ranked = rankQueue(queue(prs), config, NOW);
    expect(ranked.needsYou.map((r) => r.pr.number)).toEqual([3, 2, 1, 4]);
    expect(ranked.needsYou[0]?.pinned).toBe("first");
    expect(ranked.needsYou[0]?.reasons[0]).toBe("↑ your rule: payments/ first");
    expect(ranked.needsYou[3]?.reasons[0]).toBe("↓ your rule: bots last");
    // Without the rules, the urgent, stacked PR leads.
    expect(rankQueue(queue(prs), configWith({}), NOW).needsYou.map((r) => r.pr.number)).toEqual([1, 3, 2, 4]);
  });

  it("keeps a first rule's PR first even while its CI is failing", () => {
    const prs = [facts({ number: 1, ci: "failure", title: "Release notes" }), facts({ number: 2 })];
    const config = configWith({ rules: [{ when: { title: "release" }, then: "first" }] });
    expect(rankQueue(queue(prs), config, NOW).needsYou.map((r) => r.pr.number)).toEqual([1, 2]);
  });

  it("orders fast-track by your first and last rules too", () => {
    const docs = (number: number, hours: number, path: string) =>
      facts({
        number,
        files: [{ path, additions: 3, deletions: 0 }],
        request: { direct: true, teams: [], requestedAt: hoursAgo(hours) },
      });
    const prs = [docs(1, 30, "docs/a.md"), docs(2, 5, "docs/api/b.md")];
    const config = configWith({ rules: [{ when: { path: "docs/api/" }, then: "first" }] });
    expect(rankQueue(queue(prs), config, NOW).fastTrack.map((r) => r.pr.number)).toEqual([2, 1]);
  });

  it("boosts and lowers by points, shown in the score and its breakdown", () => {
    const config = configWith({
      rules: [
        { when: { label: "security" }, then: "boost", by: 7 },
        { when: { title: "chore" }, then: "lower" },
      ],
    });
    const r = rankPullRequest(facts({ labels: ["security"], title: "chore: tidy" }), config, {
      now: NOW,
      authorQueueSize: 1,
    });
    expect(r.score).toMatchObject({ rules: 2, total: 2 });
    expect(r.breakdown).toEqual([
      { signal: "rule", points: 7, text: "↑ your rule: labelled security +7" },
      { signal: "rule", points: -5, text: '↓ your rule: "chore" in title −5' },
    ]);
  });

  it("never lets learning override a rule: learning that pulls against a boost or lower is set aside", () => {
    const learning: Learning = {
      repo: "acme/shop",
      paused: false,
      checks: new Map(),
      checkTallies: new Map(),
      queue: [
        {
          id: "l1",
          feature: "by:bots",
          direction: "down",
          jumps: 0,
          reactions: 4,
          total: 4,
          since: "2026-09-01T00:00:00.000Z",
        },
      ],
      queueTallies: new Map(),
      dismissed: new Map(),
      dismissedPrs: new Map(),
      reactions: new Map(),
      notes: [],
      forgottenNotes: new Map(),
    };
    const bot = facts({ author: "dependabot[bot]", authorIsBot: true });
    const context = { now: NOW, authorQueueSize: 1, learning };
    const learned = rankPullRequest(bot, configWith({}), context);
    expect(learned.score.learned).toBe(-1.5);

    const ruled = rankPullRequest(
      bot,
      configWith({ rules: [{ when: { author: "dependabot" }, then: "boost", by: 2 }] }),
      context,
    );
    expect(ruled.score.learned).toBeUndefined();
    expect(ruled.score.total).toBe(2);
    expect(ruled.breakdown?.find((l) => l.signal === "learned")?.text).toMatch(/set aside: your rule decides/);
    expect(ruled.reasons).toEqual(["↑ your rule: @dependabot +2"]);
  });
});

describe("weights", () => {
  const context = { now: NOW, authorQueueSize: 3 };
  const busy = facts({
    labels: ["hotfix"],
    stackedPrs: 1,
    codeownedFiles: ["src/app.ts"],
    additions: 400,
    deletions: 100,
    files: [
      { path: "db/migrations/001.sql", additions: 100, deletions: 0 },
      { path: "src/app.ts", additions: 300, deletions: 100 },
    ],
    request: { direct: true, teams: [], requestedAt: hoursAgo(30) },
  });

  it("breaks the default score down by named weight, adding up to the total", () => {
    const r = rankPullRequest(busy, configWith({}), context);
    const by = Object.fromEntries((r.breakdown ?? []).map((l) => [l.signal, l.points]));
    expect(by).toEqual({
      waiting: 3,
      size: 2,
      risk: 2,
      noTests: 1,
      ownsFiles: 1,
      urgentLabel: 6,
      stacked: 4,
      sameAuthor: 2,
    });
    expect((r.breakdown ?? []).reduce((sum, l) => sum + l.points, 0)).toBe(r.score.total);
    expect(r.score.total).toBe(21);
  });

  it("multiplies each signal by its weight, and drops a signal and its reason at 0", () => {
    const r = rankPullRequest(busy, configWith({ waiting: 2, urgentLabel: 0, size: 0.5 }), context);
    const line = (signal: string) => r.breakdown?.find((l) => l.signal === signal);
    expect(line("waiting")).toMatchObject({ points: 6, weight: 2 });
    expect(line("size")).toMatchObject({ points: 1, weight: 0.5 });
    expect(line("urgentLabel")).toBeUndefined();
    expect(r.reasons).not.toContain("labelled hotfix");
    expect(r.score.total).toBe(21 + 3 - 6 - 1);
    // The raw signal counts don't move: weights change points, not facts.
    expect(r.score.blocking).toBe(3 + 2 + 1);
  });

  it("rejects weights out of range and rules with no condition", () => {
    expect(AldenConfigSchema.safeParse({ queue: { rank: { waiting: -1 } } }).success).toBe(false);
    expect(AldenConfigSchema.safeParse({ queue: { rank: { waiting: 11 } } }).success).toBe(false);
    expect(AldenConfigSchema.safeParse({ queue: { rank: { rules: [{ when: {}, then: "first" }] } } }).success).toBe(
      false,
    );
    expect(
      AldenConfigSchema.safeParse({ queue: { rank: { rules: [{ when: { path: "x/" }, then: "top" }] } } }).success,
    ).toBe(false);
  });
});
