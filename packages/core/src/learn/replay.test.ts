import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AldenConfigSchema,
  type Briefing,
  FEEDBACK_SCHEMA_VERSION,
  type FeedbackEvent,
  MEMORY_SCHEMA_VERSION,
  type OpenEvent,
  type PullRequestFacts,
} from "@alden/schema";
import { describe, expect, it } from "vitest";
import { fromRestFile } from "../diff/sources.js";
import { type RawPullRequest, toFacts } from "../github/pull-requests.js";
import { queueRows, rankQueue } from "../queue/rank.js";
import { buildBriefing } from "../review/briefing.js";
import { type Learning, learn, prFeatures } from "./learn.js";

/**
 * Replays recorded feedback over real, recorded PRs (the eval fixtures) and checks what a reviewer would see change:
 * the proof that Alden learns, on the same data the evals use.
 */
const FIXTURES = join(import.meta.dirname, "../github/__fixtures__");
const config = AldenConfigSchema.parse({});
const viewer = { login: "eval", teams: new Set<string>() };

function fixture(name: string): { prs: PullRequestFacts[]; raw: RawPullRequest[] } {
  const data = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as { pullRequests: RawPullRequest[] };
  return { raw: data.pullRequests, prs: data.pullRequests.map((raw) => toFacts(raw, viewer)) };
}

function briefing(name: string, number: number, learning?: Learning): Briefing {
  const pr = fixture(name).prs.find((p) => p.number === number) as PullRequestFacts;
  const files = (
    JSON.parse(readFileSync(join(FIXTURES, "diffs", `${name}-${number}.json`), "utf8")) as Parameters<
      typeof fromRestFile
    >[0][]
  ).map(fromRestFile);
  return buildBriefing({
    target: {
      kind: "pr",
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
      title: pr.title,
      author: pr.author,
      baseRef: pr.baseRef,
      headRef: pr.headRef,
    },
    files,
    pr,
    config,
    manifests: [],
    ...(learning ? { learning } : {}),
  });
}

let n = 0;
/** "Not needed" (or agree) on the place a briefing showed, as the UI sends it. */
function verdictOn(b: Briefing, index: number, verdict: "agree" | "not_needed" | "dismiss"): FeedbackEvent {
  const item = b.needsYourEyes[index];
  if (!item || b.target.kind !== "pr") throw new Error("no such place");
  return {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    id: `r${n++}`,
    at: "2026-09-27T10:00:00.000Z",
    kind: "verdict",
    target: { kind: "pr", repo: b.target.repo, number: b.target.number },
    briefingAt: b.generatedAt,
    item: {
      source: "check",
      ...(item.checkId ? { checkId: item.checkId } : {}),
      title: item.title,
      ...(item.anchor ? { anchor: item.anchor } : {}),
      placement: "eyes",
    },
    verdict,
  };
}

const learned = (repo: string, feedback: FeedbackEvent[], opens: OpenEvent[] = []) =>
  learn({ repo, feedback, opens, memory: [], now: new Date("2026-09-28T12:00:00Z") });

describe("replaying feedback on recorded PRs", () => {
  it("vercel/next.js: three untested-change flags marked not needed, then the next PR's are hidden, with a reason", () => {
    const before = briefing("nextjs", 99367);
    expect(before.needsYourEyes.map((e) => e.checkId)).toEqual(["tests.missing", "tests.missing", "tests.missing"]);

    // The same reviewer said "not needed" to that flag on three other next.js PRs.
    const earlier = [99369, 85741, 85741].map((number, i) =>
      verdictOn(briefing(number === 99369 ? "nextjs" : "reg-nextjs", number), i === 2 ? 1 : 0, "not_needed"),
    );
    const after = briefing("nextjs", 99367, learned("vercel/next.js", earlier));
    expect(after.needsYourEyes).toEqual([]);
    expect(after.learning?.hidden).toHaveLength(3);
    expect(after.learning?.hidden[0]?.reason).toBe("You usually mark untested-change flags not needed (3 of 3)");
    // The check itself still ran and still says what it found.
    expect(after.checks.find((c) => c.id === "tests.missing")?.status).toBe("flagged");
  });

  it("laravel/framework: a place dismissed on a PR stays down on its re-review, and the next flagged file takes its slot", () => {
    const before = briefing("laravel", 60005);
    expect(before.needsYourEyes.map((e) => e.checkId)).toEqual(["config.changed"]);
    const after = briefing("laravel", 60005, learned("laravel/framework", [verdictOn(before, 0, "dismiss")]));
    // Only that place is dismissed: another file the same check flagged takes the slot.
    const dismissed = before.needsYourEyes[0]?.anchor?.path;
    expect(after.needsYourEyes.map((e) => e.anchor?.path)).not.toContain(dismissed);
    expect(after.needsYourEyes).toHaveLength(1);
    expect(after.learning?.hidden.map((h) => [h.title, h.reason])).toEqual([
      [before.needsYourEyes[0]?.title, "You dismissed it on 2026-09-27"],
    ]);
  });

  it("django/django: a high-severity migration flag is never quietened, however often it's marked not needed", () => {
    const before = briefing("reg-django", 19057);
    const flag = verdictOn(before, 0, "not_needed");
    const others = [1, 2, 3, 4].map(
      (i) => ({ ...flag, id: `m${i}`, target: { ...flag.target, number: i } }) as FeedbackEvent,
    );
    const after = briefing("reg-django", 19057, learned("django/django", others));
    expect(after.needsYourEyes.map((e) => e.checkId)).toContain("migrations.changed");
  });
});

describe("replaying opens on a recorded queue", () => {
  it("django/django: opening one author's PRs ahead of their rank lifts their next PR, and says why", () => {
    const { prs } = fixture("reg-django");
    const queue = {
      viewer: "eval",
      fetchedAt: "2026-09-28T12:00:00Z",
      pullRequests: prs.map((pr) => ({ ...pr, ci: "success" as const })),
      warnings: [],
    };
    const now = Date.parse("2026-09-28T12:00:00Z");
    const before = rankQueue(queue, config.queue, now);
    const last = before.needsYou.at(-1)?.pr as PullRequestFacts;
    const author = `author:${last.author?.toLowerCase()}`;
    expect(prFeatures(last, config.queue.sensitivePaths)).toContain(author);

    // Three earlier sessions where the reviewer skipped past others to open this author's PRs.
    const rows = queueRows(before, config.queue);
    const opens: OpenEvent[] = [1, 2, 3].map((i) => ({
      schemaVersion: MEMORY_SCHEMA_VERSION,
      id: `q${i}`,
      at: `2026-09-2${i}T09:00:00.000Z`,
      repo: "django/django",
      number: 1000 + i,
      position: rows.length - 1,
      features: [author],
      via: "ui",
    }));
    const learning = learned("django/django", [], opens);
    const after = rankQueue(queue, config.queue, now, (repo) => (repo === "django/django" ? learning : undefined));
    const lifted = after.needsYou.find((r) => r.pr.number === last.number);
    expect(lifted?.score.learned).toBe(1.5);
    expect(lifted?.reasons).toContain(`ranked higher: you usually open @${last.author?.toLowerCase()}'s PRs first`);
    expect(after.needsYou.indexOf(lifted as never)).toBeLessThan(before.needsYou.length - 1);
    // Rows keep the unlearned order, so opening it now doesn't count as another jump.
    expect(queueRows(after, config.queue).find((r) => r.number === last.number)?.base).toBe(before.needsYou.length - 1);
  });
});
