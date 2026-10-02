import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeedbackInput } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeStores } from "../store/db.js";
import { FeedbackLog, redactFeedback, summarizeFeedback } from "./log.js";

let dir: string;
let log: FeedbackLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alden-feedback-"));
  log = new FeedbackLog(join(dir, "alden.db"));
});
afterEach(async () => {
  closeStores();
  await rm(dir, { recursive: true, force: true });
});

const target = { kind: "pr" as const, repo: "acme/api", number: 7 };
const briefingAt = "2026-09-30T10:00:00.000Z";
const eyes = (checkId: string, line: number) => ({
  source: "check" as const,
  checkId,
  title: `${checkId} flag`,
  severity: "high" as const,
  anchor: { path: "src/charge.ts", line },
  placement: "eyes" as const,
});
const verdict = (item: ReturnType<typeof eyes>, v: "agree" | "not_needed" | "clear"): FeedbackInput => ({
  kind: "verdict",
  target,
  briefingAt,
  item,
  verdict: v,
});

describe("FeedbackLog", () => {
  it("keeps the latest verdict per flag, drops cleared ones, and counts the gate's rate on needs-your-eyes", async () => {
    await log.add(verdict(eyes("callers.outside", 3), "not_needed"), new Date("2026-09-30T10:01:00Z"));
    await log.add(verdict(eyes("callers.outside", 3), "agree"), new Date("2026-09-30T10:02:00Z"));
    await log.add(verdict(eyes("tests.missing", 9), "not_needed"), new Date("2026-09-30T10:03:00Z"));
    await log.add(verdict(eyes("secrets.likely", 1), "agree"), new Date("2026-09-30T10:04:00Z"));
    await log.add(verdict(eyes("secrets.likely", 1), "clear"), new Date("2026-09-30T10:05:00Z"));
    await log.add(
      {
        kind: "verdict",
        target,
        briefingAt,
        model: "claude-sonnet-5",
        item: { source: "llm", title: "Null check missing", placement: "finding" },
        verdict: "agree",
      },
      new Date("2026-09-30T10:06:00Z"),
    );
    await log.add({ kind: "missed", target, briefingAt, note: "The migration drops a column" });

    const summary = await log.summary();
    expect(summary).toMatchObject({
      verdicts: 3,
      agree: 2,
      notNeeded: 1,
      eyes: { agree: 1, notNeeded: 1 },
      modelFindings: { agree: 1, notNeeded: 0 },
      bySource: { check: { agree: 1, notNeeded: 1 }, llm: { agree: 1, notNeeded: 0 } },
      byCheck: {
        "callers.outside": { agree: 1, notNeeded: 0 },
        "tests.missing": { agree: 0, notNeeded: 1 },
        model: { agree: 1, notNeeded: 0 },
      },
      missed: 1,
      briefings: 1,
      since: "2026-09-30T10:01:00.000Z",
    });
    expect(summary.eyesAgreeRate).toBe(0.5);
  });

  it("counts a re-review of the same PR as a new briefing", async () => {
    await log.add(verdict(eyes("tests.missing", 9), "agree"));
    await log.add({ ...verdict(eyes("tests.missing", 9), "not_needed"), briefingAt: "2026-10-01T09:00:00.000Z" });
    const summary = await log.summary();
    expect([summary.briefings, summary.agree, summary.notNeeded]).toEqual([2, 1, 1]);
  });

  it("refuses malformed input", async () => {
    await expect(log.add({ kind: "verdict", target, briefingAt, verdict: "maybe" })).rejects.toThrow();
    await expect(log.add({ kind: "missed", target, briefingAt, note: "" })).rejects.toThrow();
    expect(await log.events()).toEqual([]);
  });

  it("imports the JSON-lines files Alden kept before the database, skipping broken lines", async () => {
    const legacy = await mkdtemp(join(tmpdir(), "alden-legacy-"));
    const kept = await new FeedbackLog(join(dir, "other.db")).add(
      verdict(eyes("tests.missing", 9), "agree"),
      new Date("2026-09-30T10:00:00Z"),
    );
    await mkdir(join(legacy, "feedback"));
    await writeFile(
      join(legacy, "feedback", "2026-09.jsonl"),
      `${JSON.stringify(kept)}\n{"kind":"verdi\nnot json\n{"kind":"missed"}\n`,
    );
    const imported = new FeedbackLog(join(legacy, "alden.db"));
    expect(await imported.events()).toEqual([kept]);
    // The old folder moves out of the way, and isn't imported twice.
    expect(await readdir(join(legacy, "legacy"))).toEqual(["feedback"]);
    closeStores();
    await rm(legacy, { recursive: true, force: true });
  });

  it("summarises an empty log", async () => {
    expect(await log.summary()).toMatchObject({ verdicts: 0, eyesAgreeRate: null, briefings: 0, since: null });
  });
});

describe("redactFeedback", () => {
  it("hashes repos consistently and drops titles, places and notes", async () => {
    await log.add(verdict(eyes("tests.missing", 9), "agree"));
    await log.add({
      kind: "missed",
      target,
      briefingAt,
      note: "The migration drops a column",
      anchor: { path: "db/x.sql" },
    });
    const redacted = redactFeedback(await log.events());
    const text = JSON.stringify(redacted);
    for (const secret of ["acme/api", "src/charge.ts", "db/x.sql", "migration", "tests.missing flag"]) {
      expect(text).not.toContain(secret);
    }
    expect(redacted[0]?.target).toEqual(redacted[1]?.target);
    expect(redacted[0]?.target).toMatchObject({
      kind: "pr",
      number: 7,
      repo: expect.stringMatching(/^repo-[0-9a-f]{12}$/),
    });
    expect(redacted[0]?.kind === "verdict" && redacted[0].item.checkId).toBe("tests.missing");
  });

  it("keeps two flags of one check apart, so the redacted log summarises like the real one", async () => {
    await log.add(verdict(eyes("tests.missing", 9), "agree"));
    await log.add(verdict(eyes("tests.missing", 30), "not_needed"));
    await log.add(verdict(eyes("tests.missing", 9), "not_needed"));
    const redacted = redactFeedback(await log.events());
    const titles = redacted.map((e) => (e.kind === "verdict" ? e.item.title : ""));
    expect(titles[0]).toMatch(/^\(redacted [0-9a-f]{12}\)$/);
    expect(titles[0]).toBe(titles[2]);
    expect(titles[0]).not.toBe(titles[1]);
    expect(summarizeFeedback(redacted)).toMatchObject({ verdicts: 2, notNeeded: 2 });
    // A new export, a new salt: codes from one export can't be matched to another's.
    const again = redactFeedback(await log.events());
    expect(again[0]?.kind === "verdict" && again[0].item.title).not.toBe(titles[0]);
  });
});
