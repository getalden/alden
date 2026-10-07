import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Briefing, ReviewDraft } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FeedbackLog } from "../feedback/log.js";
import type { GitHubClient } from "../github/client.js";
import { addNote, loadLearning } from "../learn/learn.js";
import { AldenStore } from "../store/db.js";
import { ReviewDrafts, sendReview } from "./drafts.js";
import {
  type BriefedPlace,
  briefedPlaces,
  confirmNotes,
  learnFromReview,
  reviewSignals,
  type SeenPlace,
  SIGNAL_WEIGHTS,
  wasSeen,
} from "./signals.js";

const REPO = "acme/shop";
const PR = "acme/shop#7";

const sensitive: BriefedPlace = {
  title: "Money maths changed",
  reason: "r",
  anchor: { path: "src/pay.ts", line: 14 },
  checkId: "paths.sensitive",
  severity: "medium",
};
const untested: BriefedPlace = {
  title: "No tests for pay",
  reason: "r",
  anchor: { path: "src/pay.ts", line: 40 },
  checkId: "tests.missing",
  severity: "low",
};
const secret: BriefedPlace = {
  title: "Likely secret",
  reason: "r",
  anchor: { path: "src/keys.ts", line: 2 },
  checkId: "secrets.likely",
  severity: "low",
};
const severe: BriefedPlace = {
  title: "Drops a column",
  reason: "r",
  anchor: { path: "db/1.sql", line: 1 },
  checkId: "migrations.changed",
  severity: "critical",
};
const old: BriefedPlace = {
  title: "Kept before 0.7",
  reason: "r",
  anchor: { path: "src/a.ts", line: 3 },
  checkId: "x",
};

let id = 0;
const draft = (path: string, line: number, extra: Partial<ReviewDraft> = {}): ReviewDraft => ({
  id: `d${id++}`,
  pr: PR,
  headSha: "h1",
  path,
  line,
  side: "RIGHT",
  body: "Hm?",
  source: "you",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  state: "draft",
  ...extra,
});
const seenAll = (places: BriefedPlace[]): SeenPlace[] =>
  places.map((p) => ({
    path: p.anchor?.path ?? "",
    ...(p.anchor?.line !== undefined ? { line: p.anchor.line } : {}),
    how: "guided" as const,
  }));

describe("the signals a review gives", () => {
  const base = { repo: REPO, number: 7, seen: [] as SeenPlace[] };

  it("weighs a comment near a flag by what it says: requested changes and suggestions over a plain comment", () => {
    const drafts = [draft("src/pay.ts", 12), draft("src/pay.ts", 41, { suggestion: "pay(cents)" })];
    const places = [sensitive, untested];
    expect(reviewSignals({ ...base, event: "COMMENT", places, drafts })).toEqual([
      expect.objectContaining({
        signal: "comment",
        checkId: "paths.sensitive",
        path: "src/pay.ts",
        line: 14,
        weight: 1,
      }),
      expect.objectContaining({ signal: "suggestion", checkId: "tests.missing", line: 40, weight: 2 }),
    ]);
    expect(reviewSignals({ ...base, event: "REQUEST_CHANGES", places, drafts }).map((s) => s.signal)).toEqual([
      "request_changes",
      "request_changes",
    ]);
    expect(SIGNAL_WEIGHTS).toMatchObject({ request_changes: 2, suggestion: 2, comment: 1, silent_pass: 0.2, miss: 1 });
  });

  it("counts a linked note at the code it links to, and a comment where nothing was flagged as a miss", () => {
    const linked = draft("x", 1, {
      path: undefined,
      line: undefined,
      side: undefined,
      linkTo: { path: "src/pay.ts", line: 16 },
    });
    const elsewhere = draft("src/cart.ts", 5);
    const left = draft("src/cart.ts", 9, { side: "LEFT" });
    const general = draft("x", 1, { path: undefined, line: undefined, side: undefined });
    expect(
      reviewSignals({ ...base, event: "COMMENT", places: [sensitive], drafts: [linked, elsewhere, left, general] }),
    ).toEqual([
      expect.objectContaining({ signal: "comment", checkId: "paths.sensitive" }),
      { repo: REPO, pr: 7, source: "review", signal: "miss", path: "src/cart.ts", line: 5, weight: 1 },
      // A removed line's number isn't a line of the file at the head.
      { repo: REPO, pr: 7, source: "review", signal: "miss", path: "src/cart.ts", weight: 1 },
    ]);
  });

  it("counts a silent pass only when you saw the place and approved, and never on what mustn't be quietened", () => {
    const places = [sensitive, untested, secret, severe, old];
    const seen = seenAll(places);
    expect(reviewSignals({ ...base, seen, event: "APPROVE", places, drafts: [] })).toEqual([
      expect.objectContaining({ signal: "silent_pass", checkId: "paths.sensitive", weight: 0.2 }),
      expect.objectContaining({ signal: "silent_pass", checkId: "tests.missing", weight: 0.2 }),
    ]);
    // Not seen, or not an approval: nothing.
    expect(reviewSignals({ ...base, event: "APPROVE", places, drafts: [] })).toEqual([]);
    expect(reviewSignals({ ...base, seen, event: "COMMENT", places, drafts: [] })).toEqual([]);
    expect(reviewSignals({ ...base, seen, event: "REQUEST_CHANGES", places, drafts: [draft("src/z.ts", 1)] })).toEqual([
      expect.objectContaining({ signal: "miss" }),
    ]);
    // Your own verdict on a place wins over anything the review says about it.
    expect(
      reviewSignals({
        ...base,
        seen,
        event: "APPROVE",
        places,
        drafts: [],
        yours: (p) => p.checkId === "tests.missing",
      }),
    ).toEqual([expect.objectContaining({ checkId: "paths.sensitive" })]);
  });

  it("knows a place was seen by its file, check and nearby line", () => {
    const at = (line?: number, checkId?: string): SeenPlace => ({
      path: "src/pay.ts",
      how: "diff",
      ...(line !== undefined ? { line } : {}),
      ...(checkId ? { checkId } : {}),
    });
    expect(wasSeen(sensitive, [at(17)])).toBe(true);
    expect(wasSeen(sensitive, [at(18)])).toBe(false);
    expect(wasSeen(sensitive, [at()])).toBe(true);
    expect(wasSeen(sensitive, [at(14, "tests.missing")])).toBe(false);
    expect(wasSeen(sensitive, [{ path: "src/other.ts", how: "diff" }])).toBe(false);
  });

  it("keeps each place's severity with the briefing, from its check or the model's finding", () => {
    const briefing = {
      needsYourEyes: [
        { title: "a", reason: "r", checkId: "tests.missing" },
        { title: "Null check", reason: "r", source: "llm" },
        { title: "c", reason: "r", checkId: "gone" },
      ],
      checks: [{ id: "tests.missing", severity: "low" }],
      llm: { findings: [{ title: "Null check", severity: "high" }] },
    } as unknown as Briefing;
    expect(briefedPlaces(briefing).map((p) => p.severity)).toEqual(["low", "high", undefined]);
  });
});

let home: string;
let store: AldenStore;
const savedHome = process.env.ALDEN_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "alden-signals-"));
  process.env.ALDEN_HOME = home;
  store = AldenStore.open(join(home, "alden.db"));
});
afterEach(() => {
  store.close();
  if (savedHome === undefined) delete process.env.ALDEN_HOME;
  else process.env.ALDEN_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const briefed = { briefingAt: "2026-10-01T00:00:00.000Z", places: [sensitive, untested] };
const pr = { repo: REPO, number: 7, headSha: "h1" };

describe("recording what a review taught", () => {
  it("records a place once per PR, unless a later review says more about it", async () => {
    const at = (day: number) => new Date(Date.UTC(2026, 9, day));
    const first = await learnFromReview(store, pr, "COMMENT", briefed, [draft("src/pay.ts", 12)], { now: at(1) });
    expect(first.map((s) => s.signal)).toEqual(["comment"]);
    // The same comment again: nothing new. A suggestion there: it says more.
    expect(await learnFromReview(store, pr, "COMMENT", briefed, [draft("src/pay.ts", 13)], { now: at(2) })).toEqual([]);
    const more = await learnFromReview(store, pr, "COMMENT", briefed, [draft("src/pay.ts", 12, { suggestion: "" })], {
      now: at(3),
    });
    expect(more.map((s) => s.signal)).toEqual(["suggestion"]);
    // Approving past it after commenting on it, or the same miss twice, adds nothing.
    const seen = () => seenAll(briefed.places);
    const approved = await learnFromReview(store, pr, "APPROVE", briefed, [draft("src/cart.ts", 3)], {
      now: at(4),
      seen,
    });
    expect(approved.map((s) => s.signal)).toEqual(["silent_pass", "miss"]);
    expect(approved[0]?.checkId).toBe("tests.missing");
    expect(
      await learnFromReview(store, pr, "APPROVE", briefed, [draft("src/cart.ts", 3)], { now: at(5), seen }),
    ).toEqual([]);
    expect(new FeedbackLog(store).signals(REPO)).toHaveLength(4);
  });

  it("never counts a place you gave a verdict on yourself", async () => {
    await new FeedbackLog(store).add({
      kind: "verdict",
      target: { kind: "pr", repo: REPO, number: 7 },
      briefingAt: briefed.briefingAt,
      item: {
        source: "check",
        checkId: "paths.sensitive",
        title: sensitive.title,
        anchor: sensitive.anchor,
        placement: "eyes",
      },
      verdict: "not_needed",
    });
    expect(await learnFromReview(store, pr, "COMMENT", briefed, [draft("src/pay.ts", 12)])).toEqual([]);
  });

  it("records nothing when learning from reviews is off, by the setting or in your config", async () => {
    expect(await learnFromReview(store, pr, "COMMENT", briefed, [draft("src/pay.ts", 12)], { enabled: false })).toEqual(
      [],
    );
    writeFileSync(join(home, "config.toml"), "[learning]\nfromReviews = false\n");
    expect(await learnFromReview(store, pr, "COMMENT", briefed, [draft("src/pay.ts", 12)])).toEqual([]);
    expect(new FeedbackLog(store).signals()).toEqual([]);
  });

  it("confirms the note behind a finding a comment is near, instead of giving a check signal", async () => {
    const note = addNote(store, REPO, "Money is in cents", new Date("2026-09-01T00:00:00.000Z"));
    const fromNote: BriefedPlace = {
      title: "Float maths on money",
      reason: "r",
      source: "llm",
      anchor: { path: "src/pay.ts", line: 14 },
      fromNote: { id: note.item, text: "Money is in cents" },
      severity: "low",
    };
    const withNote = { briefingAt: briefed.briefingAt, places: [fromNote, untested] };
    const drafts = [draft("src/pay.ts", 15, { suggestion: "" }), draft("src/pay.ts", 41)];
    // The note's place gives no signal, and a comment near it isn't a miss; approving past it says nothing either.
    const signals = await learnFromReview(store, pr, "APPROVE", withNote, drafts, { seen: () => seenAll([fromNote]) });
    expect(signals.map((s) => [s.signal, s.checkId])).toEqual([["comment", "tests.missing"]]);
    expect(await confirmNotes(store, pr, withNote, drafts)).toEqual([note.item]);
    // Once per place per PR.
    expect(await confirmNotes(store, pr, withNote, drafts)).toEqual([]);
    const learning = await loadLearning(store, REPO);
    expect(learning.notes[0]?.confirmed).toBe(1);
    expect(learning.checkTallies.get("tests.missing")?.agree).toBe(1);
    expect([...learning.checkTallies.keys()]).toEqual(["tests.missing"]);
    // Not when learning from reviews is off.
    expect(await confirmNotes(store, { ...pr, number: 8 }, withNote, drafts, { enabled: false })).toEqual([]);
  });

  it("still learns the rest when what you saw can't be read", async () => {
    const seen = () => {
      throw new Error("no seen table");
    };
    const recorded = await learnFromReview(store, pr, "APPROVE", briefed, [draft("src/pay.ts", 12)], { seen });
    expect(recorded.map((s) => s.signal)).toEqual(["comment"]);
  });
});

describe("sending a review that teaches", () => {
  const V1 = [
    "@@ -10,6 +10,7 @@ export function pay()",
    " const a = 1;",
    " const b = 2;",
    "-const total = a + b;",
    "+const total = a + b + fee;",
    "+log(total);",
    " }",
    " ",
  ].join("\n");
  const github = () =>
    ({
      request: async (route: string, params: Record<string, unknown>) => {
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return { data: { head: { sha: "h1" } } };
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
          const file = { filename: "src/pay.ts", status: "modified", additions: 2, deletions: 1, patch: V1 };
          return { data: params.page === 1 ? [file] : [] };
        }
        if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
          return { data: { html_url: "https://github.com/acme/shop/pull/7#pullrequestreview-1" } };
        }
        throw new Error(`unexpected ${route}`);
      },
    }) as unknown as GitHubClient;
  const briefing = {
    target: { kind: "pr", repo: REPO, number: 7 },
    generatedAt: "2026-10-01T00:00:00.000Z",
    needsYourEyes: [
      { title: sensitive.title, reason: "r", anchor: sensitive.anchor, checkId: "paths.sensitive" },
      { title: untested.title, reason: "r", anchor: { path: "src/pay.ts", line: 12 }, checkId: "tests.missing" },
    ],
    checks: [
      { id: "paths.sensitive", severity: "medium" },
      { id: "tests.missing", severity: "low" },
    ],
  } as unknown as Briefing;

  it("records a silent pass for a place you saw and approved past, with what you saw from the reader given", async () => {
    const drafts = new ReviewDrafts(store);
    drafts.rememberBriefing(briefing);
    const asked: unknown[] = [];
    const seen = (_store: AldenStore, prName: string, headSha?: string) => {
      asked.push([prName, headSha]);
      return [{ checkId: "tests.missing", path: "src/pay.ts", line: 12, how: "guided" as const }];
    };
    const result = await sendReview(github(), store, { repo: REPO, number: 7, event: "APPROVE" }, new Date(), {
      seen,
    });
    expect(asked).toEqual([[PR, "h1"]]);
    expect(result.counts.signals).toMatchObject({ silent_pass: 1 });
    expect(result.counts.learned).toBe(0);
    // Approving in silence says too little to report.
    expect(result.learning).toBeUndefined();
    expect(new FeedbackLog(store).signals(REPO)).toEqual([
      expect.objectContaining({ signal: "silent_pass", checkId: "tests.missing", weight: 0.2 }),
    ]);
  });

  it("says which note a comment near one of its findings confirmed", async () => {
    const note = addNote(store, REPO, "Money is in cents", new Date("2026-09-01T00:00:00.000Z"));
    const drafts = new ReviewDrafts(store);
    drafts.rememberBriefing({
      ...briefing,
      needsYourEyes: [
        {
          title: "Float maths on money",
          reason: "r",
          source: "llm",
          anchor: { path: "src/pay.ts", line: 13 },
          fromNote: { id: note.item, text: "Money is in cents" },
        },
      ],
    } as Briefing);
    drafts.add({
      pr: PR,
      headSha: "h1",
      body: "Cents?",
      source: "you",
      place: {
        path: "src/pay.ts",
        line: 13,
        side: "RIGHT",
        anchor: { text: "const total = a + b + fee;" },
        lines: ["const total = a + b + fee;"],
      },
    });
    const result = await sendReview(github(), store, { repo: REPO, number: 7, event: "COMMENT" }, new Date(), {
      fromReviews: true,
    });
    expect(result.counts.learned).toBe(1);
    expect(Object.values(result.counts.signals).every((n) => n === 0)).toBe(true);
    expect(result.learning).toEqual([
      'Your review of acme/shop#7 confirmed your note "Money is in cents" (confirmed 1×).',
    ]);
  });

  it("records nothing with learning from reviews off, and still sends", async () => {
    const drafts = new ReviewDrafts(store);
    drafts.rememberBriefing(briefing);
    drafts.add({
      pr: PR,
      headSha: "h1",
      body: "Cents?",
      source: "you",
      place: {
        path: "src/pay.ts",
        line: 13,
        side: "RIGHT",
        anchor: { text: "const total = a + b + fee;" },
        lines: ["const total = a + b + fee;"],
      },
    });
    const result = await sendReview(github(), store, { repo: REPO, number: 7, event: "COMMENT" }, new Date(), {
      fromReviews: false,
    });
    expect(result.posted).toBe(1);
    expect(result.counts.learned).toBe(0);
    expect(Object.values(result.counts.signals).every((n) => n === 0)).toBe(true);
    expect(new FeedbackLog(store).signals()).toEqual([]);
  });
});
