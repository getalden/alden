import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AldenConfigSchema, RankedQueueSchema } from "@alden/schema";
import { describe, expect, it } from "vitest";
import { type PullRequestFacts, type RawPullRequest, toFacts } from "../github/pull-requests.js";
import type { ReviewQueue } from "../github/queue.js";
import { formatAge, rankPullRequest, rankQueue } from "./rank.js";

const config = AldenConfigSchema.parse({}).queue;
const NOW = Date.parse("2026-09-28T18:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function facts(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    repo: "getalden/alden",
    number: 1,
    title: "Change something",
    url: "https://github.com/getalden/alden/pull/1",
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

const rank = (pr: PullRequestFacts, authorQueueSize = 1) => rankPullRequest(pr, config, { now: NOW, authorQueueSize });

describe("rankPullRequest", () => {
  it("gives a small, tested, fresh PR no reasons and a zero score", () => {
    const r = rank(facts());
    expect(r.score).toEqual({ risk: 0, wait: 0, blocking: 0, total: 0 });
    expect(r.reasons).toEqual([]);
    expect(r.lane).toBe("needs-you");
  });

  it("scores waiting time in steps, using when the viewer was asked", () => {
    const at = (h: number) => rank(facts({ request: { direct: true, teams: [], requestedAt: hoursAgo(h) } }));
    expect([at(3), at(5), at(30), at(80)].map((r) => r.score.wait)).toEqual([0, 1, 2, 3]);
    expect(at(80).reasons).toContain("waiting 3d");
  });

  it("falls back to when the PR opened if GitHub didn't record the request", () => {
    const r = rank(facts({ createdAt: hoursAgo(50), request: { direct: false, teams: [], requestedAt: null } }));
    expect(r.reasons).toContain("waiting 2d");
  });

  it("explains risk: size, sensitive paths, missing tests, ownership", () => {
    const r = rank(
      facts({
        additions: 400,
        deletions: 100,
        files: [
          { path: "database/migrations/2026_09_28_add_index.php", additions: 30, deletions: 0 },
          { path: "app/Models/User.php", additions: 370, deletions: 100 },
        ],
        codeownedFiles: ["app/Models/User.php"],
      }),
    );
    expect(r.score.risk).toBe(2 + 2 + 1 + 1);
    expect(r.reasons).toEqual(
      expect.arrayContaining([
        "large (+400/-100)",
        "touches database/migrations/",
        "no test changes",
        "you own 1 file",
      ]),
    );
  });

  it("marks failing CI as waiting on the author, not as risk, and says so first", () => {
    const r = rank(facts({ ci: "failure", labels: ["urgent"] }));
    expect(r.waitingOnAuthor).toBe(true);
    expect(r.score.risk).toBe(0);
    expect(r.reasons[0]).toBe("CI failing: ping @sam");
    expect(rank(facts({ ci: "failure", author: null })).reasons[0]).toBe("CI failing: ping the author");
    expect(rank(facts({ ci: "pending" })).waitingOnAuthor).toBe(false);
  });

  it("treats truncated file lists as very large", () => {
    expect(rank(facts({ filesTruncated: true })).score.risk).toBeGreaterThanOrEqual(3);
  });

  it("explains blocking: urgent labels, stacked PRs, authors with several PRs waiting", () => {
    const r = rank(facts({ labels: ["type: hotfix"], stackedPrs: 2 }), 3);
    expect(r.score.blocking).toBe(3 + 2 + 1);
    expect(r.reasons.slice(0, 3)).toEqual([
      "labelled type: hotfix",
      "2 PRs stacked on it",
      "@sam has 3 PRs waiting on you",
    ]);
  });

  it("puts the heaviest reason first", () => {
    const r = rank(facts({ labels: ["urgent"], request: { direct: true, teams: [], requestedAt: hoursAgo(80) } }));
    expect(r.reasons[0]).toBe("labelled urgent");
  });

  it("notes conflicts and drafts without scoring them", () => {
    const r = rank(facts({ mergeable: "conflicting", isDraft: true }));
    expect(r.score.total).toBe(0);
    expect(r.reasons).toEqual(["has conflicts", "draft"]);
  });
});

describe("size and bots", () => {
  it("leaves lockfiles out of a PR's size", () => {
    const r = rank(
      facts({
        additions: 1200,
        deletions: 40,
        files: [
          { path: "src/app.ts", additions: 20, deletions: 5 },
          { path: "src/app.test.ts", additions: 10, deletions: 0 },
          { path: "package-lock.json", additions: 1170, deletions: 35 },
        ],
      }),
    );
    // The lockfile still counts as a sensitive path (new dependencies), just not as size.
    expect(r.score.risk).toBe(2);
    expect(r.reasons).toEqual(["touches package-lock.json"]);
  });

  it("fast-tracks a patch bump whose lockfile diff is big", () => {
    const r = rank(
      facts({
        title: "Bump tmpl from 1.0.4 to 1.0.5",
        additions: 491,
        deletions: 8,
        files: [
          { path: "package.json", additions: 1, deletions: 1 },
          { path: "package-lock.json", additions: 245, deletions: 4 },
          { path: "yarn.lock", additions: 245, deletions: 3 },
        ],
      }),
    );
    expect(r).toMatchObject({ lane: "fast-track", fastTrack: "dependency patch bump" });
  });

  it("doesn't treat a bot's pile of PRs as a teammate waiting", () => {
    expect(rank(facts({ author: "dependabot", authorIsBot: true }), 28).reasons).toEqual([]);

    const ranked = rankQueue(
      {
        viewer: "me",
        fetchedAt: hoursAgo(0),
        warnings: [],
        pullRequests: [1, 2, 3].map((n) => facts({ number: n, author: "dependabot", authorIsBot: true })),
      },
      config,
      NOW,
    );
    expect(ranked.needsYou.every((r) => r.score.blocking === 0)).toBe(true);
  });
});

describe("fast-track", () => {
  const docs = facts({
    additions: 12,
    deletions: 3,
    files: [{ path: "docs/install.md", additions: 12, deletions: 3 }],
  });

  it("fast-tracks small, green docs-only, tests-only and patch-bump PRs", () => {
    expect(rank(docs)).toMatchObject({ lane: "fast-track", fastTrack: "docs only" });

    const tests = facts({ files: [{ path: "tests/test_queue.py", additions: 20, deletions: 5 }] });
    expect(rank(tests)).toMatchObject({ lane: "fast-track", fastTrack: "tests only" });

    const bump = facts({
      title: "Bump lodash from 4.17.20 to 4.17.21",
      files: [
        { path: "package.json", additions: 1, deletions: 1 },
        { path: "pnpm-lock.yaml", additions: 10, deletions: 10 },
      ],
    });
    expect(rank(bump)).toMatchObject({ lane: "fast-track", fastTrack: "dependency patch bump" });
  });

  it("fast-tracks docs in a repo with no CI, but not tests or bumps", () => {
    expect(rank({ ...docs, ci: "none" })).toMatchObject({ lane: "fast-track", fastTrack: "docs only" });

    const tests = facts({ ci: "none", files: [{ path: "tests/test_queue.py", additions: 20, deletions: 5 }] });
    expect(rank(tests).lane).toBe("needs-you");

    const bump = facts({
      ci: "none",
      title: "Bump object-path from 0.11.4 to 0.11.8",
      files: [{ path: "package-lock.json", additions: 3, deletions: 3 }],
    });
    expect(rank(bump).lane).toBe("needs-you");
  });

  it("keeps a minor version bump in needs-you", () => {
    const bump = facts({
      title: "Bump react from 19.0.0 to 19.1.0",
      files: [{ path: "package.json", additions: 1, deletions: 1 }],
    });
    expect(rank(bump).lane).toBe("needs-you");
  });

  it.each([
    ["CI not green", { ci: "pending" as const }],
    ["too big", { files: [{ path: "docs/install.md", additions: 60, deletions: 3 }] }],
    ["conflicting", { mergeable: "conflicting" as const }],
    ["a draft", { isDraft: true }],
    ["truncated", { filesTruncated: true }],
  ])("does not fast-track a docs PR that is %s", (_label, overrides) => {
    expect(rank({ ...docs, ...overrides }).lane).toBe("needs-you");
  });

  it("does not fast-track docs under a sensitive path", () => {
    const pr = facts({ files: [{ path: "app/auth/README.md", additions: 3, deletions: 0 }] });
    expect(rank(pr).lane).toBe("needs-you");
  });

  it("respects the configured size limit", () => {
    const bigger = { ...docs, files: [{ path: "docs/install.md", additions: 70, deletions: 0 }] };
    const context = { now: NOW, authorQueueSize: 1 };
    expect(rankPullRequest(bigger, config, context).lane).toBe("needs-you");
    expect(rankPullRequest(bigger, { ...config, fastTrackMaxLines: 100 }, context).lane).toBe("fast-track");
  });
});

describe("rankQueue", () => {
  it("orders needs-you by score with failing CI last, fast-track by waiting time, and counts PRs per author", () => {
    const queue: ReviewQueue = {
      viewer: "me",
      fetchedAt: hoursAgo(0),
      warnings: [],
      pullRequests: [
        facts({ number: 1, author: "ana" }),
        // Scores highest of all, but its CI is failing, so it sinks to the bottom.
        facts({ number: 2, author: "sam", ci: "failure", labels: ["urgent"] }),
        facts({ number: 3, author: "sam", labels: ["hotfix"] }),
        facts({
          number: 4,
          author: "lee",
          files: [{ path: "README.md", additions: 1, deletions: 1 }],
          request: { direct: true, teams: [], requestedAt: hoursAgo(10) },
        }),
        facts({
          number: 5,
          author: "lee",
          files: [{ path: "docs/a.md", additions: 1, deletions: 1 }],
          request: { direct: true, teams: [], requestedAt: hoursAgo(30) },
        }),
      ],
    };
    const ranked = rankQueue(queue, config, NOW);
    expect(ranked.needsYou.map((r) => r.pr.number)).toEqual([3, 1, 2]);
    expect(ranked.fastTrack.map((r) => r.pr.number)).toEqual([5, 4]);
    expect(ranked.needsYou[0]?.reasons).toContain("@sam has 2 PRs waiting on you");
  });

  it("ranks every recorded real PR without throwing", () => {
    const dir = join(import.meta.dirname, "../github/__fixtures__");
    const pullRequests = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .flatMap(
        (f) => (JSON.parse(readFileSync(join(dir, f), "utf8")) as { pullRequests: RawPullRequest[] }).pullRequests,
      )
      .map((raw) => toFacts(raw, { login: "someone", teams: new Set() }));

    const ranked = rankQueue({ viewer: "someone", fetchedAt: hoursAgo(0), warnings: [], pullRequests }, config, NOW);
    expect(ranked.needsYou.length + ranked.fastTrack.length).toBe(pullRequests.length);
    // What `alden queue --json` prints must match the published schema.
    expect(RankedQueueSchema.safeParse(JSON.parse(JSON.stringify(ranked))).error).toBeUndefined();
    for (const r of [...ranked.needsYou, ...ranked.fastTrack]) {
      expect(r.score.total).toBeGreaterThanOrEqual(0);
      expect(r.reasons.every((text) => text.length > 0 && text.length < 60)).toBe(true);
    }
  });
});

describe("formatAge", () => {
  it("uses hours under two days, then days", () => {
    expect([0.5, 5, 47.9, 48, 80].map(formatAge)).toEqual(["<1h", "5h", "47h", "2d", "3d"]);
  });
});
