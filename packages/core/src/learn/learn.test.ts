import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AldenConfigSchema,
  type CheckResult,
  FEEDBACK_SCHEMA_VERSION,
  type FeedbackEvent,
  MEMORY_SCHEMA_VERSION,
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
  describeFeature,
  forget,
  learn,
  loadLearning,
  memoryItems,
  OPEN_BOOST,
  openBoost,
  prFeatures,
  promptNotes,
  recordOpen,
} from "./learn.js";

const REPO = "acme/shop";
const config = AldenConfigSchema.parse({});
let n = 0;
const at = (day: number) => new Date(Date.UTC(2026, 8, day, 12)).toISOString();

function verdict(
  checkId: string,
  v: "agree" | "not_needed" | "clear",
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

  it("remembers a flag you dismissed on a PR, whatever its line", () => {
    const learning = learn({
      repo: REPO,
      feedback: [verdict("config.changed", "not_needed", { pr: 7, title: "Config change in .env", path: ".env" })],
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
    expect(learning.opens.map((o) => o.feature)).toEqual(["author:sam", "path:db/migrations/"]);
    expect(openBoost(learning, ["path:db/migrations/"])).toEqual({
      points: OPEN_BOOST,
      reason: "ranked higher: you usually open PRs touching db/migrations/ first",
    });
    // Two learned features add up, to a cap.
    expect(openBoost(learning, ["author:sam", "path:db/migrations/"]).points).toBe(3);
  });

  it("ignores working down the list in order, opens outside the lane, and old opens", () => {
    const inOrder = [1, 2, 3, 4].map(() => open(["author:sam"], 0));
    const fastTrack = [1, 2, 3].map(() => open(["author:sam"], -1));
    const old = [1, 2, 3].map(() => open(["author:sam"], 3, 1));
    const learning = learn({ repo: REPO, feedback: [], opens: [...inOrder, ...fastTrack], memory: [], now: NOW });
    expect(learning.opens).toEqual([]);
    // Opened on 1 September; by 20 December they're outside the 90 days that count.
    expect(learn({ repo: REPO, feedback: [], opens: old, memory: [], now: NOW }).opens).toHaveLength(1);
    expect(
      learn({ repo: REPO, feedback: [], opens: old, memory: [], now: new Date(Date.UTC(2026, 11, 20)) }).opens,
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
      "author:sam",
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
    expect(again.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(1);
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
      ["learned", "You usually don't need untested-change flags"],
    ]);
    expect(items[1]).toMatchObject({ id: "check:tests.missing:down", evidence: "marked not needed 3 of 3 times" });

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
    expect(recordOpen(store, rows, rows[2] as never, "ui", t(0))).toBe(true); // skipped #1 and #2
    expect(recordOpen(store, rows, rows[0] as never, "ui", t(1))).toBe(true); // then the top
    expect(recordOpen(store, rows, rows[1] as never, "ui", t(2))).toBe(true); // next unopened: in order
    expect(recordOpen(store, rows, rows[1] as never, "ui", t(3))).toBe(false); // a reopen
    expect(recordOpen(store, rows, rows[3] as never, "cli", t(4))).toBe(true); // fast-track
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

  it("hides what you dismissed or don't need, says so, and puts what you care about first", () => {
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
    expect(eyes[1]?.learned).toBe("You usually agree with config-change flags (3 of 3)");
    expect(hidden).toEqual([
      {
        title: "Untested change in src/a.ts",
        reason: "You usually mark untested-change flags not needed (3 of 3)",
        anchor: { path: "src/a.ts" },
      },
    ]);
  });

  it("keeps a flag dismissed on this PR down on a re-review, and only on this PR", () => {
    const learning = learn({
      repo: REPO,
      feedback: [
        verdict("config.changed", "not_needed", {
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
      "You marked it not needed on 2026-09-20",
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
    expect(notes).toEqual(["Money is in cents, never floats", "Cares about migration issues."]);
    const prompt = buildPrompt({
      target: { kind: "local", repoRoot: "/x", branch: null },
      files: [],
      checks: [],
      maxInputTokens: 10_000,
      reviewerNotes: notes,
    });
    expect(prompt.user).toContain("## What the reviewer cares about (from the reviewer, not the author)");
    expect(prompt.user).toContain("- Money is in cents, never floats");
    expect(prompt.reviewerNotes).toBe(2);
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
