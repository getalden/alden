import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AldenConfigSchema,
  type CheckResult,
  FEEDBACK_SCHEMA_VERSION,
  type FeedbackEvent,
  MEMORY_SCHEMA_VERSION,
  type MemoryEvent,
  type OpenEvent,
  type PullRequestFacts,
} from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FeedbackLog } from "../feedback/log.js";
import { buildPrompt } from "../review/llm/prompt.js";
import { pickWithLearning } from "../review/pick.js";
import { AldenStore, openStore } from "../store/db.js";
import {
  addNote,
  checkProgress,
  describeFeature,
  editNote,
  forget,
  forgetAll,
  learn,
  loadLearning,
  memoryItems,
  noteArea,
  notePath,
  noteStoppedAt,
  OPEN_BOOST,
  prFeatures,
  promptNotes,
  queueBoost,
  reactionProgress,
  recordOpen,
  recordReaction,
  restore,
  scopeNote,
  setLearning,
} from "./learn.js";

const REPO = "acme/shop";
const config = AldenConfigSchema.parse({});
let n = 0;
const at = (day: number) => new Date(Date.UTC(2026, 8, day, 12)).toISOString();

function verdict(
  checkId: string,
  v: "agree" | "not_needed" | "dismiss" | "clear",
  options: { pr?: number; day?: number; title?: string; path?: string } = {},
): FeedbackEvent {
  const day = options.day ?? 20;
  return {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    id: `f${n++}`,
    at: at(day),
    kind: "verdict",
    target: { kind: "pr", repo: REPO, number: options.pr ?? n },
    briefingAt: at(day),
    item: {
      source: "check",
      checkId,
      title: options.title ?? `${checkId} in x`,
      anchor: { path: options.path ?? "x" },
      placement: "eyes",
    },
    verdict: v,
  };
}

const open = (features: string[], position: number, day = 20): OpenEvent => ({
  schemaVersion: MEMORY_SCHEMA_VERSION,
  id: `o${n++}`,
  at: at(day),
  repo: REPO,
  number: n,
  position,
  features,
  via: "cli",
});

const NOW = new Date(at(28));

describe("learn: checks", () => {
  it("needs three one-sided verdicts before a check moves", () => {
    const two = learn({
      repo: REPO,
      feedback: [1, 2].map(() => verdict("tests.missing", "not_needed")),
      opens: [],
      memory: [],
      now: NOW,
    });
    expect(two.checks.size).toBe(0);
    const three = learn({
      repo: REPO,
      feedback: [1, 2, 3].map(() => verdict("tests.missing", "not_needed")),
      opens: [],
      memory: [],
      now: NOW,
    });
    expect(three.checks.get("tests.missing")).toMatchObject({ direction: "down", notNeeded: 3, agree: 0 });
  });

  it("stays put when verdicts are mixed", () => {
    const feedback = [
      ...[1, 2, 3].map(() => verdict("config.changed", "agree")),
      ...[1, 2].map(() => verdict("config.changed", "not_needed")),
    ];
    expect(learn({ repo: REPO, feedback, opens: [], memory: [], now: NOW }).checks.size).toBe(0);
  });

  it("learns what you care about", () => {
    const feedback = [1, 2, 3, 4].map(() => verdict("migrations.changed", "agree"));
    expect(
      learn({ repo: REPO, feedback, opens: [], memory: [], now: NOW }).checks.get("migrations.changed"),
    ).toMatchObject({
      direction: "up",
      agree: 4,
    });
  });

  it("never quietens the secrets check", () => {
    const feedback = [1, 2, 3, 4, 5].map(() => verdict("secrets.likely", "not_needed"));
    expect(learn({ repo: REPO, feedback, opens: [], memory: [], now: NOW }).checks.size).toBe(0);
  });

  it("counts only the latest verdict on a flag, so a taken-back verdict doesn't count", () => {
    const feedback = [1, 2, 3].flatMap((pr) => [
      verdict("tests.missing", "not_needed", { pr }),
      verdict("tests.missing", "clear", { pr }),
    ]);
    expect(learn({ repo: REPO, feedback, opens: [], memory: [], now: NOW }).checks.size).toBe(0);
  });

  it("remembers a flag you dismissed on a PR, whatever its line; not useful doesn't hide it", () => {
    const learning = learn({
      repo: REPO,
      feedback: [
        verdict("config.changed", "dismiss", { pr: 7, title: "Config change in .env", path: ".env" }),
        verdict("tests.missing", "not_needed", { pr: 7 }),
      ],
      opens: [],
      memory: [],
      now: NOW,
    });
    expect([...learning.dismissed.keys()]).toEqual(["acme/shop#7|check|config.changed|Config change in .env|.env"]);
  });
});

describe("learn: opens", () => {
  it("boosts PRs you open ahead of their rank, with the reason shown", () => {
    const opens = [1, 2, 3].map(() => open(["path:db/migrations/", "author:sam"], 2));
    const learning = learn({ repo: REPO, feedback: [], opens, memory: [], now: NOW });
    expect(learning.queue.map((o) => o.feature)).toEqual(["author:sam", "path:db/migrations/"]);
    expect(queueBoost(learning, ["path:db/migrations/"])).toEqual({
      points: OPEN_BOOST,
      reason: "ranked higher: you usually open PRs touching db/migrations/ first",
    });
    // Two learned features add up, to a cap.
    expect(queueBoost(learning, ["author:sam", "path:db/migrations/"]).points).toBe(3);
    // Paused: kept, not applied.
    expect(queueBoost({ ...learning, paused: true }, ["author:sam"]).points).toBe(0);
  });

  it("ignores working down the list in order, opens outside the lane, and old opens", () => {
    const inOrder = [1, 2, 3, 4].map(() => open(["author:sam"], 0));
    const fastTrack = [1, 2, 3].map(() => open(["author:sam"], -1));
    const old = [1, 2, 3].map(() => open(["author:sam"], 3, 1));
    const learning = learn({ repo: REPO, feedback: [], opens: [...inOrder, ...fastTrack], memory: [], now: NOW });
    expect(learning.queue).toEqual([]);
    // Opened on 1 September; by 20 December they're outside the 90 days that count.
    expect(learn({ repo: REPO, feedback: [], opens: old, memory: [], now: NOW }).queue).toHaveLength(1);
    expect(
      learn({ repo: REPO, feedback: [], opens: old, memory: [], now: new Date(Date.UTC(2026, 11, 20)) }).queue,
    ).toEqual([]);
  });

  it("describes features in words", () => {
    expect(["path:app/auth/", "author:sam", "label:api", "kind:dependency"].map(describeFeature)).toEqual([
      "PRs touching app/auth/",
      "@sam's PRs",
      "PRs labelled api",
      "dependency changes",
    ]);
  });

  it("reads a PR's features: sensitive dirs, dependencies, a human author and labels", () => {
    const pr = {
      files: [
        { path: "db/migrations/0042_add.sql", additions: 1, deletions: 0 },
        { path: "package-lock.json", additions: 1, deletions: 0 },
        { path: "src/a.ts", additions: 1, deletions: 0 },
      ],
      author: "Sam",
      authorIsBot: false,
      labels: ["API"],
    } as PullRequestFacts;
    expect(prFeatures(pr, config.queue.sensitivePaths)).toEqual([
      "area:src",
      "author:sam",
      "by:people",
      "kind:dependency",
      "label:api",
      "path:db/migrations/",
    ]);
    expect(prFeatures({ ...pr, authorIsBot: true }, config.queue.sensitivePaths)).not.toContain("author:sam");
  });
});

describe("the store, memory and opens", () => {
  let dir: string;
  let store: AldenStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alden-learn-"));
    store = openStore(join(dir, "alden.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("migrates once and survives reopening", () => {
    store.close();
    const again = AldenStore.open(join(dir, "alden.db"));
    expect(again.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(5);
    expect(again.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
    again.close();
    store = openStore(join(dir, "alden.db"));
  });

  it("lists notes and learned items, and forgets either", async () => {
    const log = new FeedbackLog(store);
    for (const e of [1, 2, 3].map(() => verdict("tests.missing", "not_needed"))) {
      store.addEvent({ id: e.id, at: e.at, type: "feedback", repo: REPO, body: e });
    }
    const note = addNote(store, "Acme/Shop", "  Check that new endpoints have auth  ", NOW);
    expect(await log.events(REPO)).toHaveLength(3);

    const items = memoryItems(await loadLearning(store, REPO, NOW));
    expect(items.map((i) => [i.source, i.text])).toEqual([
      ["you", "Check that new endpoints have auth"],
      ["learned", "You usually find untested-change flags not useful"],
    ]);
    expect(items[1]).toMatchObject({
      id: "check:tests.missing:down",
      group: "skip",
      evidence: "you marked 3 of 3 not useful",
      examples: 3,
    });

    expect(await forget(store, REPO, "nope", NOW)).toBe(false);
    expect(await forget(store, REPO, "check:tests.missing:down", NOW)).toBe(true);
    expect(await forget(store, REPO, note.item, NOW)).toBe(true);
    expect(memoryItems(await loadLearning(store, REPO, NOW))).toEqual([]);

    // Forgetting starts over: three new verdicts after it bring the lesson back.
    const later = new Date(NOW.getTime() + 60_000);
    for (const i of [1, 2, 3]) {
      const e = { ...verdict("tests.missing", "not_needed"), at: new Date(later.getTime() + i).toISOString() };
      store.addEvent({ id: e.id, at: e.at, type: "feedback", repo: REPO, body: e });
    }
    expect((await loadLearning(store, REPO, later)).checks.get("tests.missing")?.notNeeded).toBe(3);
  });

  it("edits notes, restores what was forgotten, pauses learning and forgets everything", async () => {
    for (const e of [1, 2, 3].map(() => verdict("migrations.changed", "agree"))) {
      store.addEvent({ id: e.id, at: e.at, type: "feedback", repo: REPO, body: e });
    }
    const note = addNote(store, REPO, "Cents, not floats", NOW);
    const id = note.action === "add" ? note.item : "";
    expect(await editNote(store, REPO, id, "Money is in cents, never floats", NOW)).toBe(true);
    expect(await editNote(store, REPO, "note:nope", "x", NOW)).toBe(false);
    expect((await loadLearning(store, REPO, NOW)).notes.map((n) => n.text)).toEqual([
      "Money is in cents, never floats",
    ]);

    await forget(store, REPO, id, NOW);
    await forget(store, REPO, "check:migrations.changed:up", NOW);
    expect(memoryItems(await loadLearning(store, REPO, NOW))).toEqual([]);
    const later = new Date(NOW.getTime() + 1000);
    expect(restore(store, REPO, id, later)).toBe(true);
    expect(restore(store, REPO, "check:migrations.changed:up", later)).toBe(true);
    expect(restore(store, REPO, "never-forgotten", later)).toBe(false);
    expect(memoryItems(await loadLearning(store, REPO, later)).map((i) => i.id)).toEqual([
      id,
      "check:migrations.changed:up",
    ]);

    setLearning(store, REPO, false, later);
    const paused = await loadLearning(store, REPO, later);
    expect(paused.paused).toBe(true);
    // Paused: listed, notes still go to the model, learned preferences don't.
    expect(memoryItems(paused)).toHaveLength(2);
    expect(promptNotes(paused)).toEqual([{ id, text: "Money is in cents, never floats" }]);
    setLearning(store, REPO, true, new Date(later.getTime() + 1));
    expect((await loadLearning(store, REPO, new Date(later.getTime() + 2))).paused).toBe(false);

    expect(await forgetAll(store, REPO, new Date(later.getTime() + 3))).toBe(2);
    expect(memoryItems(await loadLearning(store, REPO, new Date(later.getTime() + 4)))).toEqual([]);
  });

  it("learns from row reactions: up and down move PRs like it, dismiss hides a PR until it changes", async () => {
    const row = (number: number, features: string[]) => ({ repo: REPO, number, features });
    for (const i of [1, 2, 3]) recordReaction(store, row(i, ["label:docs"]), "down", at(1), NOW);
    for (const i of [4, 5, 6]) recordReaction(store, row(i, ["path:db/"]), "up", at(1), NOW);
    recordReaction(store, row(7, ["label:x"]), "dismiss", at(10), NOW);
    recordReaction(store, row(8, ["label:x"]), "dismiss", at(10), NOW);
    recordReaction(store, row(8, ["label:x"]), "clear", at(10), new Date(NOW.getTime() + 1));
    const learning = await loadLearning(store, REPO, new Date(NOW.getTime() + 2));
    expect(learning.queue.map((l) => [l.feature, l.direction])).toEqual([
      ["label:docs", "down"],
      ["path:db/", "up"],
    ]);
    expect(queueBoost(learning, ["label:docs"])).toEqual({
      points: -OPEN_BOOST,
      reason: "ranked lower: you usually skip PRs labelled docs (3 marked not useful)",
    });
    expect(queueBoost(learning, ["path:db/"]).reason).toBe("ranked higher: you marked 3 PRs touching db/ useful");
    expect([...learning.dismissedPrs]).toEqual([[`${REPO}#7`, at(10)]]);
    expect(memoryItems(learning).map((i) => [i.group, i.text])).toEqual([
      ["skip", "You usually skip PRs labelled docs"],
      ["look", "You look at PRs touching db/ first"],
    ]);
  });

  it("refuses an empty or very long note", () => {
    expect(() => addNote(store, REPO, "   ")).toThrow(/needs some text/);
    expect(() => addNote(store, REPO, "x".repeat(501))).toThrow(/under 500/);
  });

  it("counts an open's position among PRs you haven't opened lately, and ignores reopens", async () => {
    const row = (number: number, base: number) => ({
      url: `https://github.com/${REPO}/pull/${number}`,
      repo: REPO,
      number,
      features: [`author:a${number}`],
      base,
    });
    const rows = [row(1, 0), row(2, 1), row(3, 2), row(4, -1)];
    const t = (min: number) => new Date(NOW.getTime() + min * 60_000);
    expect(recordOpen(store, rows, rows[2] as never, "ui", t(0))).toBeTruthy(); // skipped #1 and #2
    expect(recordOpen(store, rows, rows[0] as never, "ui", t(1))).toBeTruthy(); // then the top
    expect(recordOpen(store, rows, rows[1] as never, "ui", t(2))).toBeTruthy(); // next unopened: in order
    expect(recordOpen(store, rows, rows[1] as never, "ui", t(3))).toBeUndefined(); // a reopen
    expect(recordOpen(store, rows, rows[3] as never, "cli", t(4))).toBeTruthy(); // fast-track
    const opens = store.events<OpenEvent>("open", { repo: REPO });
    expect(opens.map((o) => [o.number, o.position])).toEqual([
      [3, 2],
      [1, 0],
      [2, 0],
      [4, -1],
    ]);
  });
});

describe("using what was learned", () => {
  const check = (id: string, severity: CheckResult["severity"], paths: string[]): CheckResult => ({
    id,
    title: id,
    status: "flagged",
    severity,
    summary: `${id} flagged.`,
    evidence: paths.map((path) => ({ text: `in ${path}`, anchor: { path } })),
    heuristic: false,
  });
  const checks = [
    check("tests.missing", "medium", ["src/a.ts"]),
    check("config.changed", "medium", ["config/app.php"]),
    check("migrations.changed", "high", ["db/migrations/1.sql"]),
  ];

  it("hides what you dismissed or find not useful, says so, and puts what you care about first", () => {
    const learning = learn({
      repo: REPO,
      feedback: [
        ...[1, 2, 3].map(() => verdict("tests.missing", "not_needed")),
        ...[1, 2, 3].map(() => verdict("migrations.changed", "not_needed")),
        ...[1, 2, 3].map(() => verdict("config.changed", "agree")),
      ],
      opens: [],
      memory: [],
      now: NOW,
    });
    const { eyes, hidden } = pickWithLearning(checks, learning, "acme/shop#9");
    // High severity is never quietened; config goes before other mediums; tests are left out, with the reason.
    expect(eyes.map((e) => e.checkId)).toEqual(["migrations.changed", "config.changed"]);
    expect(eyes[1]?.learned).toBe("You usually mark config-change flags useful (3 of 3)");
    expect(hidden).toEqual([
      {
        title: "Untested change in src/a.ts",
        reason: "You usually mark untested-change flags not useful (3 of 3)",
        anchor: { path: "src/a.ts" },
      },
    ]);
  });

  it("never quietens a critical flag you usually don't need", () => {
    const learning = learn({
      repo: REPO,
      feedback: [1, 2, 3].map(() => verdict("secrets.likely", "not_needed")),
      opens: [],
      memory: [],
      now: NOW,
    });
    const { eyes, hidden } = pickWithLearning(
      [check("secrets.likely", "critical", ["src/keys.ts"])],
      learning,
      "acme/shop#9",
    );
    expect(eyes.map((e) => e.checkId)).toEqual(["secrets.likely"]);
    expect(hidden).toEqual([]);
  });

  it("keeps a flag dismissed on this PR down on a re-review, and only on this PR", () => {
    const learning = learn({
      repo: REPO,
      feedback: [
        verdict("config.changed", "dismiss", {
          pr: 9,
          title: "Config change in config/app.php",
          path: "config/app.php",
        }),
      ],
      opens: [],
      memory: [],
      now: NOW,
    });
    expect(pickWithLearning(checks, learning, "acme/shop#9").hidden.map((h) => h.reason)).toEqual([
      "You dismissed it on 2026-09-20",
    ]);
    expect(pickWithLearning(checks, learning, "acme/shop#10").hidden).toEqual([]);
  });

  it("gives the model your notes and what you care about, marked as the reviewer's", () => {
    const learning = learn({
      repo: REPO,
      feedback: [1, 2, 3].map(() => verdict("migrations.changed", "agree")),
      opens: [],
      memory: [
        {
          schemaVersion: MEMORY_SCHEMA_VERSION,
          id: "m1",
          at: at(20),
          repo: REPO,
          action: "add",
          item: "note:1",
          text: "Money is in cents, never floats",
        },
      ],
      now: NOW,
    });
    const notes = promptNotes(learning);
    expect(notes).toEqual([{ id: "note:1", text: "Money is in cents, never floats" }, "Cares about migration issues."]);
    const prompt = buildPrompt({
      target: { kind: "local", repoRoot: "/x", branch: null },
      files: [],
      checks: [],
      maxInputTokens: 10_000,
      reviewerNotes: notes,
    });
    expect(prompt.user).toContain("## What the reviewer cares about (from the reviewer, not the author)");
    expect(prompt.user).toContain("- [N1] Money is in cents, never floats");
    expect(prompt.user).toContain("- Cares about migration issues.");
    expect(prompt.reviewerNotes).toBe(2);
    expect(prompt.notes).toEqual(new Map([["N1", { id: "note:1", text: "Money is in cents, never floats" }]]));
    expect(
      buildPrompt({
        target: { kind: "local", repoRoot: "/x", branch: null },
        files: [],
        checks: [],
        maxInputTokens: 10_000,
      }).user,
    ).not.toContain("cares about");
  });
});

describe("learning from who wrote a PR and where it changes", () => {
  const files = (...paths: [string, number][]) =>
    paths.map(([path, lines]) => ({ path, additions: lines, deletions: 0 }));
  const facts = (over: Partial<PullRequestFacts>) =>
    ({ files: [], author: "sam", authorIsBot: false, headRef: "feature", labels: [], ...over }) as PullRequestFacts;

  it("reads bot and agent PRs: kind, identity and code areas", () => {
    const dependabot = facts({
      author: "dependabot",
      authorIsBot: true,
      files: files(["package.json", 2], ["pnpm-lock.yaml", 400]),
    });
    expect(prFeatures(dependabot, config.queue.sensitivePaths)).toEqual([
      "area:.",
      "author:bot:dependabot",
      "by:bots",
      "kind:dependency",
    ]);
    const copilot = facts({
      author: "Copilot",
      authorIsBot: true,
      files: files(["app/api/users/route.ts", 40], ["py/pricing/calc.py", 10]),
    });
    expect(prFeatures(copilot, [])).toEqual(["area:app/api", "area:py/pricing", "author:agent:copilot", "by:agents"]);
    // A person's PR from Claude's branch is Claude's, and theirs.
    expect(prFeatures(facts({ headRef: "claude/issue-4", files: files(["py/x.py", 1]) }), [])).toEqual([
      "area:py",
      "author:agent:claude",
      "author:sam",
      "by:agents",
    ]);
    expect(prFeatures(facts({ author: "Me" }), [], "me")).toEqual(["by:you"]);
  });

  it("keeps the three code areas with the most changed lines, and doesn't repeat a sensitive directory", () => {
    const pr = facts({
      files: files(["a/x/1.ts", 5], ["b/y/1.ts", 50], ["c/1.ts", 20], ["d/z/q/1.ts", 30], ["db/migrations/1.sql", 1]),
    });
    expect(prFeatures(pr, ["db/migrations/**"]).filter((f) => f.startsWith("area:") || f.startsWith("path:"))).toEqual([
      "area:b/y",
      "area:c",
      "area:d/z",
      "path:db/migrations/",
    ]);
  });

  it("describes them the way the queue says them", () => {
    expect(
      [
        "area:app/api",
        "area:.",
        "by:bots",
        "by:agents",
        "by:people",
        "by:you",
        "author:bot:dependabot",
        "author:agent:copilot",
      ].map(describeFeature),
    ).toEqual([
      "PRs touching app/api",
      "PRs touching files at the repo root",
      "bot PRs",
      "PRs from AI agents",
      "PRs from people",
      "your own PRs",
      "Dependabot PRs",
      "Copilot PRs",
    ]);
  });

  it("learns you skip Dependabot PRs, without counting it twice as a bot PR", () => {
    const reactions = [1, 2, 3].map((number) => ({
      schemaVersion: MEMORY_SCHEMA_VERSION as typeof MEMORY_SCHEMA_VERSION,
      id: `r${number}`,
      at: at(20),
      repo: REPO,
      number,
      reaction: "down" as const,
      features: ["area:.", "author:bot:dependabot", "by:bots", "kind:dependency"],
      updatedAt: at(20),
    }));
    const learning = learn({ repo: REPO, feedback: [], opens: [], memory: [], reactions, now: NOW });
    expect(queueBoost(learning, ["author:bot:dependabot", "by:bots"])).toEqual({
      points: -OPEN_BOOST,
      reason: "ranked lower: you usually skip Dependabot PRs (3 marked not useful)",
    });
    // Who wrote it and what it touches are different things, and do add up, to the cap.
    expect(queueBoost(learning, ["author:bot:dependabot", "kind:dependency"]).points).toBe(-2 * OPEN_BOOST);
  });

  it("learns you open PRs touching app/api first, only from jumps past PRs that don't touch it", () => {
    const opened = (number: number, features: string[], jumped: string[]): OpenEvent => ({
      ...open(features, 2),
      number,
      jumped,
    });
    const opens = [1, 2, 3].map((i) => opened(i, ["area:app/api", "by:people"], ["area:app/api"]));
    const learning = learn({ repo: REPO, feedback: [], opens, memory: [], now: NOW });
    // Every PR in the queue was from people, so passing over them said nothing about people.
    expect(learning.queue.map((l) => l.feature)).toEqual(["area:app/api"]);
    expect(queueBoost(learning, ["area:app/api"]).reason).toBe(
      "ranked higher: you usually open PRs touching app/api first",
    );
  });

  it("counts one PR opened ahead on three days as one PR", () => {
    const opens = [20, 21, 22].map((day) => ({ ...open(["area:py/pricing"], 2, day), number: 7 }));
    const learning = learn({ repo: REPO, feedback: [], opens, memory: [], now: NOW });
    expect(learning.queue).toEqual([]);
    expect(learning.queueTallies.get("area:py/pricing")).toEqual({ opens: 1, jumps: 1, ups: 0, downs: 0 });
  });

  it("records which features an open jumped for", () => {
    const dir = mkdtempSync(join(tmpdir(), "alden-learn-"));
    const store = openStore(join(dir, "alden.db"));
    try {
      const row = (number: number, base: number, features: string[]) => ({
        url: `https://github.com/${REPO}/pull/${number}`,
        repo: REPO,
        number,
        features,
        base,
      });
      const rows = [row(1, 0, ["by:people", "area:docs"]), row(2, 1, ["by:people", "area:app/api"])];
      expect(recordOpen(store, rows, rows[1] as never, "ui", NOW)).toMatchObject({
        position: 1,
        jumped: ["area:app/api"],
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("learning by topic", () => {
  const llmVerdict = (
    checkId: string | undefined,
    v: "agree" | "not_needed",
    pr: number,
    title = "x",
  ): FeedbackEvent => ({
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    id: `l${n++}`,
    at: at(20),
    kind: "verdict",
    target: { kind: "pr", repo: REPO, number: pr },
    briefingAt: at(20),
    item: { source: "llm", ...(checkId ? { checkId } : {}), title, anchor: { path: "x" }, placement: "finding" },
    verdict: v,
  });

  it("counts public signatures and callers outside the diff as one API change lesson", () => {
    const feedback = [
      verdict("signatures.changed", "not_needed"),
      verdict("signatures.changed", "not_needed"),
      verdict("callers.outside", "not_needed"),
    ];
    const learning = learn({ repo: REPO, feedback, opens: [], memory: [], now: NOW });
    expect(learning.checks.get("api")).toMatchObject({ id: "check:api:down", notNeeded: 3 });
    const callers: CheckResult = {
      id: "callers.outside",
      title: "Callers",
      status: "flagged",
      severity: "medium",
      summary: "s",
      evidence: [{ text: "t", anchor: { path: "src/b.ts" } }],
      heuristic: true,
    };
    const picked = pickWithLearning([callers], learning, "acme/shop#99");
    expect(picked.eyes).toEqual([]);
    expect(picked.quietened).toEqual([
      {
        checkId: "callers.outside",
        reason: "quietened by your feedback: you usually mark API change flags not useful (3 of 3)",
      },
    ]);
    expect(memoryItems(learning)[0]).toMatchObject({
      text: "You usually find API change flags not useful",
      evidence: "you marked 3 of 3 not useful (public signature and caller flags count together)",
    });
  });

  it("keeps a forget made by check id, from before topics, in force", () => {
    const feedback = [1, 2, 3].map(() => verdict("signatures.changed", "not_needed"));
    const memory = [
      {
        schemaVersion: MEMORY_SCHEMA_VERSION as typeof MEMORY_SCHEMA_VERSION,
        id: "m",
        at: at(21),
        repo: REPO,
        action: "forget" as const,
        item: "check:signatures.changed:down",
      },
    ];
    expect(learn({ repo: REPO, feedback, opens: [], memory, now: NOW }).checks.size).toBe(0);
  });

  it("lets model findings tagged with a topic teach, once per briefing", () => {
    const three = [1, 2, 3].map((pr) => llmVerdict("tests.missing", "not_needed", pr));
    expect(
      learn({ repo: REPO, feedback: three, opens: [], memory: [], now: NOW }).checks.get("tests.missing"),
    ).toMatchObject({
      direction: "down",
      notNeeded: 3,
    });
    const chatty = ["a", "b", "c"].map((title) => llmVerdict("tests.missing", "not_needed", 5, title));
    expect(
      learn({ repo: REPO, feedback: chatty, opens: [], memory: [], now: NOW }).checkTallies.get("tests.missing"),
    ).toEqual({
      agree: 0,
      notNeeded: 1,
    });
    const untagged = [1, 2, 3].map((pr) => llmVerdict(undefined, "not_needed", pr));
    expect(learn({ repo: REPO, feedback: untagged, opens: [], memory: [], now: NOW }).checks.size).toBe(0);
  });

  it("tells the model what you usually find not useful", () => {
    const feedback = [1, 2, 3].map(() => verdict("tests.missing", "not_needed"));
    expect(promptNotes(learn({ repo: REPO, feedback, opens: [], memory: [], now: NOW }))).toEqual([
      "Usually finds untested-change concerns not useful: raise them only when they're serious.",
    ]);
  });
});

describe("saying how close a lesson is", () => {
  const learned = (feedback: FeedbackEvent[]) => learn({ repo: REPO, feedback, opens: [], memory: [], now: NOW });

  it("counts toward a check lesson, and says when it's learned", () => {
    const two = learned([verdict("callers.outside", "not_needed"), verdict("signatures.changed", "not_needed")]);
    expect(checkProgress(two, { source: "check", checkId: "callers.outside" }, "not_needed")).toBe(
      "2 of 3: one more not useful on API change flags (public signature and caller flags count together) and Alden will quieten them.",
    );
    const one = learned([verdict("tests.missing", "agree")]);
    expect(checkProgress(one, { source: "check", checkId: "tests.missing" }, "agree")).toBe(
      "1 of 3: 2 more useful on untested-change flags and Alden will put them first among the places to look.",
    );
    const three = learned([1, 2, 3].map(() => verdict("tests.missing", "not_needed")));
    expect(checkProgress(three, { source: "check", checkId: "tests.missing" }, "not_needed")).toBe(
      "3 of 3 not useful on untested-change flags: Alden quietens them in this repo.",
    );
    const mixed = learned([
      ...[1, 2, 3].map(() => verdict("config.changed", "not_needed")),
      verdict("config.changed", "agree"),
      verdict("config.changed", "agree"),
    ]);
    expect(checkProgress(mixed, { source: "check", checkId: "config.changed" }, "not_needed")).toBe(
      "2 useful, 3 not useful: 3 more not useful on config-change flags and Alden will quieten them.",
    );
  });

  it("says when nothing will be learned", () => {
    const none = learned([]);
    expect(checkProgress(none, { source: "check", checkId: "secrets.likely" }, "not_needed")).toMatch(/never quietens/);
    expect(checkProgress(none, { source: "llm" }, "not_needed")).toMatch(/teaches no lesson/);
    expect(checkProgress({ ...none, paused: true }, { source: "check", checkId: "tests.missing" }, "agree")).toMatch(
      /paused/,
    );
    expect(checkProgress(none, { source: "check", checkId: "tests.missing" }, "dismiss")).toBeUndefined();
  });

  it("counts toward a queue lesson", () => {
    const reaction = (number: number) => ({
      schemaVersion: MEMORY_SCHEMA_VERSION as typeof MEMORY_SCHEMA_VERSION,
      id: `q${number}`,
      at: at(20),
      repo: REPO,
      number,
      reaction: "down" as const,
      features: ["author:bot:dependabot", "by:bots"],
      updatedAt: at(20),
    });
    const two = learn({ repo: REPO, feedback: [], opens: [], memory: [], reactions: [1, 2].map(reaction), now: NOW });
    expect(reactionProgress(two, ["author:bot:dependabot", "by:bots"], "down")).toBe(
      "Dependabot PRs: 2 not useful so far. One more and Alden will rank them lower.",
    );
    const three = learn({
      repo: REPO,
      feedback: [],
      opens: [],
      memory: [],
      reactions: [1, 2, 3].map(reaction),
      now: NOW,
    });
    expect(reactionProgress(three, ["author:bot:dependabot", "by:bots"], "down")).toBe(
      "Alden ranks Dependabot PRs lower in this repo.",
    );
  });
});

describe("findings from your notes", () => {
  const add = (item: string, text: string, day = 10): Extract<MemoryEvent, { action: "add" }> => ({
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id: `m${n++}`,
    at: at(day),
    repo: REPO,
    action: "add" as const,
    item,
    text,
  });
  const scope = (action: "exclude" | "include", item: string, path: string, day = 11): MemoryEvent => ({
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id: `m${n++}`,
    at: at(day),
    repo: REPO,
    action,
    item,
    path,
  });
  const fromNote = (
    note: string,
    v: "agree" | "not_needed" | "dismiss",
    pr: number,
    options: { title?: string; checkId?: string } = {},
  ): FeedbackEvent => ({
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    id: `nv${n++}`,
    at: at(20),
    kind: "verdict",
    target: { kind: "pr", repo: REPO, number: pr },
    briefingAt: at(20),
    item: {
      source: "llm",
      ...(options.checkId ? { checkId: options.checkId } : {}),
      title: options.title ?? "Missing code owner header",
      anchor: { path: "app/api/users/route.ts" },
      placement: "finding",
      note,
    },
    verdict: v,
  });
  const OWNERS = "note:owners";
  const memory = [add(OWNERS, "Every file needs a code owner header")];

  it("confirms the note on useful, once per review, and teaches no check either way", () => {
    const feedback = [
      fromNote(OWNERS, "agree", 1, { checkId: "tests.missing" }),
      fromNote(OWNERS, "agree", 1, { title: "Another file without a header" }),
      fromNote(OWNERS, "agree", 2),
      fromNote(OWNERS, "agree", 3),
      fromNote(OWNERS, "not_needed", 4, { checkId: "tests.missing" }),
      fromNote(OWNERS, "not_needed", 5, { checkId: "tests.missing" }),
      fromNote(OWNERS, "not_needed", 6, { checkId: "tests.missing" }),
    ];
    const learning = learn({ repo: REPO, feedback, opens: [], memory, now: NOW });
    expect(learning.notes[0]?.confirmed).toBe(3);
    expect(learning.checks.size).toBe(0);
    expect(learning.checkTallies.size).toBe(0);
    expect(learning.notes[0]?.excluded).toEqual([]);
    expect(memoryItems(learning)[0]).toMatchObject({ id: OWNERS, confirmed: 3 });
    expect(memoryItems(learning)[0]?.excluded).toBeUndefined();
  });

  it("still lets a dismiss hide the finding on that PR", () => {
    const learning = learn({ repo: REPO, feedback: [fromNote(OWNERS, "dismiss", 7)], opens: [], memory, now: NOW });
    expect([...learning.dismissed.keys()]).toEqual([
      "acme/shop#7|llm||Missing code owner header|app/api/users/route.ts",
    ]);
  });

  it("says what a reaction did to the note", () => {
    const learning = learn({ repo: REPO, feedback: [fromNote(OWNERS, "agree", 1)], opens: [], memory, now: NOW });
    const item = { source: "llm" as const, note: OWNERS };
    expect(checkProgress(learning, item, "agree")).toBe("Saved. Your note is confirmed 1×.");
    expect(checkProgress(learning, item, "not_needed")).toBe(
      "Saved. This came from your note, so it teaches no check. Nothing changes unless you stop the note here or edit it.",
    );
    expect(checkProgress(learning, { source: "llm", note: "note:gone" }, "agree")).toBe(
      "Saved. The note this came from is no longer in memory, so this teaches nothing.",
    );
  });

  it("keeps where you stopped a note, through edits, and takes it back", () => {
    const events = [
      ...memory,
      scope("exclude", OWNERS, "vendor"),
      scope("exclude", OWNERS, "app/api"),
      scope("exclude", OWNERS, "app/api"),
      { ...add(OWNERS, "x", 12), action: "edit" as const, text: "Every source file needs a code owner header" },
      scope("include", OWNERS, "vendor", 13),
      scope("exclude", "note:unknown", "x"),
    ];
    const learning = learn({ repo: REPO, feedback: [], opens: [], memory: events, now: NOW });
    expect(learning.notes).toMatchObject([
      { id: OWNERS, text: "Every source file needs a code owner header", excluded: ["app/api"] },
    ]);
    expect(memoryItems(learning)[0]).toMatchObject({
      excluded: ["app/api"],
      effect: "Given to the model with every review of this repo, except under app/api.",
    });
  });

  it("leaves a note out of the prompt when every changed file is where you stopped it, and says where otherwise", () => {
    const events = [...memory, add("note:cents", "Money is in cents"), scope("exclude", OWNERS, "app/api")];
    const learning = learn({ repo: REPO, feedback: [], opens: [], memory: events, now: NOW });
    expect(promptNotes(learning, ["app/api/a.ts", "app/api/b/c.ts"])).toEqual([
      { id: "note:cents", text: "Money is in cents" },
    ]);
    expect(promptNotes(learning, ["app/api/a.ts", "lib/x.ts"])).toEqual([
      { id: OWNERS, text: "Every file needs a code owner header", except: ["app/api"] },
      { id: "note:cents", text: "Money is in cents" },
    ]);
    // "app/apiary" isn't under "app/api".
    expect(promptNotes(learning, ["app/apiary/x.ts"])[0]).toEqual({
      id: OWNERS,
      text: "Every file needs a code owner header",
    });
    expect(noteStoppedAt(learning, OWNERS, ["app/api/a.ts"])).toBe("app/api");
    expect(noteStoppedAt(learning, OWNERS, ["app/api/a.ts", "lib/x.ts"])).toBeUndefined();
    expect(noteStoppedAt(learning, OWNERS, [])).toBeUndefined();
    expect(noteStoppedAt(learning, "note:cents", ["app/api/a.ts"])).toBeUndefined();
  });

  it("offers a finding's first two folders, or the file at the root, and cleans up a path", () => {
    expect(noteArea("app/api/users/route.ts")).toBe("app/api");
    expect(noteArea("py/x.py")).toBe("py");
    expect(noteArea("README.md")).toBe("README.md");
    expect(notePath(" ./app/api/ ")).toBe("app/api");
    expect(notePath("/vendor")).toBe("vendor");
    expect(() => notePath("../etc")).toThrow("Give a folder or file in the repo.");
    expect(() => notePath(" ")).toThrow();
  });

  describe("in the store", () => {
    let dir: string;
    let store: AldenStore;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "alden-note-scope-"));
      store = openStore(join(dir, "alden.db"));
    });
    afterEach(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("stops and applies a note again by path", async () => {
      const event = addNote(store, REPO, "Every file needs a code owner header", NOW);
      const id = event.item;
      expect(await scopeNote(store, REPO, id, "app/api/", "exclude", NOW)).toBe(true);
      expect(await scopeNote(store, REPO, id, "app/api", "exclude", NOW)).toBe(true);
      expect(await scopeNote(store, REPO, "note:nope", "app/api", "exclude", NOW)).toBe(false);
      expect(await scopeNote(store, REPO, id, "lib", "include", NOW)).toBe(false);
      expect((await loadLearning(store, REPO, NOW)).notes[0]?.excluded).toEqual(["app/api"]);
      // Only one event for the repeated exclude.
      expect(store.events("memory", { repo: REPO })).toHaveLength(2);
      const later = new Date(NOW.getTime() + 1000);
      expect(await scopeNote(store, REPO, id, "app/api", "include", later)).toBe(true);
      expect((await loadLearning(store, REPO, later)).notes[0]?.excluded).toEqual([]);
    });
  });
});
