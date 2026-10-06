import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AldenConfigSchema, type PullRequestFacts } from "@alden/schema";
import { describe, expect, it } from "vitest";
import { type RawPullRequest, toFacts } from "../github/pull-requests.js";
import type { Learning, QueueLesson } from "../learn/learn.js";
import { type RankedQueue, rankQueue } from "./rank.js";

/**
 * The default order, pinned: every recorded real PR, with CODEOWNERS, stacks, urgent labels, failing CI, conflicts,
 * waits and learned lessons spread across them so every signal is in play, ranked with the default config. The
 * snapshot was recorded before ranking had weights and rules; with neither set, it must not move.
 */
const FIXTURES = join(import.meta.dirname, "../github/__fixtures__");
const config = AldenConfigSchema.parse({}).queue;
const NOW = Date.parse("2026-09-30T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function recorded(): PullRequestFacts[] {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap(
      (f) => (JSON.parse(readFileSync(join(FIXTURES, f), "utf8")) as { pullRequests: RawPullRequest[] }).pullRequests,
    )
    .map((raw) => toFacts(raw, { login: "someone", teams: new Set() }));
}

/** Deterministic variety, by position: the recordings alone are mostly fresh, green and unowned. */
function enriched(prs: PullRequestFacts[]): PullRequestFacts[] {
  return prs.map((pr, i) => ({
    ...pr,
    request: { ...pr.request, requestedAt: hoursAgo((i * 7) % 120) },
    ...(i % 11 === 0 && pr.files[0] ? { codeownedFiles: [pr.files[0].path] } : {}),
    ...(i % 13 === 0 ? { stackedPrs: 1 + (i % 3) } : {}),
    ...(i % 17 === 0 ? { labels: [...pr.labels, "urgent"] } : {}),
    ...(i % 9 === 0 ? { ci: "failure" as const } : { ci: "success" as const }),
    ...(i % 7 === 0 ? { mergeable: "conflicting" as const } : {}),
  }));
}

const lesson = (feature: string, direction: "up" | "down"): QueueLesson => ({
  id: `l-${feature}`,
  feature,
  direction,
  jumps: direction === "up" ? 3 : 0,
  reactions: direction === "down" ? 3 : 0,
  total: 3,
  since: "2026-09-01T00:00:00.000Z",
});

function learning(repo: string, lessons: QueueLesson[]): Learning {
  return {
    repo,
    paused: false,
    checks: new Map(),
    checkTallies: new Map(),
    queue: lessons,
    queueTallies: new Map(),
    dismissed: new Map(),
    dismissedPrs: new Map(),
    reactions: new Map(),
    notes: [],
    forgottenNotes: new Map(),
  };
}

/** Lessons: every fifth PR's author opened first; bots and dependency changes skipped. */
function lessonsFor(prs: PullRequestFacts[]): (repo: string) => Learning | undefined {
  const lessons = [
    lesson("by:bots", "down"),
    lesson("kind:dependency", "down"),
    ...prs
      .filter((_, i) => i % 5 === 0 && prs[i]?.author)
      .map((pr) => lesson(`author:${pr.author?.toLowerCase()}`, "up")),
  ];
  return (repo) => learning(repo, lessons);
}

const order = (ranked: RankedQueue) => ({
  needsYou: ranked.needsYou.map((r) => `${r.pr.repo}#${r.pr.number} ${r.score.total} · ${r.reasons.join(" · ")}`),
  fastTrack: ranked.fastTrack.map((r) => `${r.pr.repo}#${r.pr.number} · ${r.fastTrack}`),
});

describe("the default order over recorded queues", () => {
  it("is unchanged for the recordings as they are", () => {
    const prs = recorded();
    expect(
      order(rankQueue({ viewer: "someone", fetchedAt: hoursAgo(0), warnings: [], pullRequests: prs }, config, NOW)),
    ).toMatchSnapshot();
  });

  it("is unchanged with every signal and learning in play", () => {
    const prs = enriched(recorded());
    const ranked = rankQueue(
      { viewer: "someone", fetchedAt: hoursAgo(0), warnings: [], pullRequests: prs },
      config,
      NOW,
      lessonsFor(prs),
    );
    expect(order(ranked)).toMatchSnapshot();
  });
});
