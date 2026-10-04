import type { Briefing } from "@alden/schema";
import { describe, expect, it } from "vitest";
import { doctorNext, nextLine, queueNext, reviewNext, wantsNext } from "./next.js";

const pr = {
  schemaVersion: 1,
  target: {
    kind: "pr",
    repo: "getalden/alden",
    number: 12,
    url: "https://github.com/getalden/alden/pull/12",
    title: "Add the review command",
    author: "sam",
    baseRef: "main",
    headRef: "sam/review",
  },
  generatedAt: "2026-09-28T18:00:00Z",
  summary: { files: 1, additions: 1, deletions: 0, reviewableAdditions: 1, reviewableDeletions: 0 },
  files: [
    { path: "a.ts", status: "modified", kind: "code", additions: 1, deletions: 0, binary: false, patchMissing: false },
  ],
  checks: [],
  needsYourEyes: [{ title: "Possible secret in a.ts", reason: "Rotate it.", anchor: { path: "a.ts", line: 1 } }],
  notChecked: [],
} satisfies Briefing;

describe("next steps", () => {
  it("prints only to a terminal, and never with --json", () => {
    const tty = { isTTY: true } as NodeJS.WriteStream;
    const pipe = { isTTY: false } as NodeJS.WriteStream;
    expect(wantsNext(false, tty)).toBe(true);
    expect(wantsNext(true, tty)).toBe(false);
    expect(wantsNext(undefined, pipe)).toBe(false);
  });

  it("is a dim line after a blank one, wrapped under itself, or nothing", () => {
    const steps = queueNext(3);
    expect(nextLine(steps, { width: 100, color: false })).toBe(
      "\nNext: alden review 1 (brief the top PR) · alden open 1 (open it on GitHub)\n",
    );
    const narrow = nextLine(steps, { width: 50, color: false }).split("\n");
    expect(narrow.slice(1, -1).every((l) => l.length <= 50)).toBe(true);
    expect(narrow[2]?.startsWith("      ")).toBe(true);
    expect(nextLine(steps, { width: 100, color: true })).toContain("\u001b[2mNext:");
    expect(nextLine(queueNext(0), { width: 100, color: false })).toBe("");
  });

  it("after a review, suggests opening it by its #, reacting to its flags, and a note", () => {
    expect(reviewNext(pr, 3).map((s) => s.command)).toEqual(["alden open 3", "alden ui", 'alden memory add "…"']);
    expect(reviewNext({ ...pr, needsYourEyes: [] }, undefined).map((s) => s.command)).toEqual(['alden memory add "…"']);
    expect(reviewNext({ ...pr, files: [] }, 3)).toEqual([]);
  });

  it("after doctor, suggests the first fix that's a whole command, failures first", () => {
    expect(
      doctorNext([
        { area: "Alden", status: "warn", detail: "old", fix: "Run `npm install -g alden@latest`." },
        { area: "Model", status: "warn", detail: "cap", fix: "`alden config set budget.dailyUsd …` raises it." },
        { area: "GitHub", status: "fail", detail: "not signed in", fix: "Run `alden auth login`." },
      ]),
    ).toEqual([{ command: "alden auth login", why: "the fix for GitHub" }]);
    expect(
      doctorNext([{ area: "Model", status: "warn", detail: "cap", fix: "`alden config set budget.dailyUsd …`" }]),
    ).toEqual([]);
    expect(doctorNext([{ area: "GitHub", status: "ok", detail: "@sam" }])).toEqual([
      { command: "alden queue", why: "see what's waiting on you" },
    ]);
  });
});
