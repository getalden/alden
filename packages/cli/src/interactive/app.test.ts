import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { fakeEngine } from "./__fixtures__/fake.js";
import { startInteractive } from "./app.js";
import { ENTER, LEAVE } from "./screen.js";

/** A terminal in a test: keys go in with `type`, everything written comes out in `written`. */
function terminal(columns = 80, rows = 24) {
  const raw: boolean[] = [];
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    paused: true,
    setRawMode(on: boolean) {
      raw.push(on);
    },
    setEncoding() {},
    resume() {
      input.paused = false;
    },
    pause() {
      input.paused = true;
    },
  });
  const written: string[] = [];
  const output = Object.assign(new EventEmitter(), {
    columns,
    rows,
    write(text: string) {
      written.push(text);
    },
  });
  // What's on screen now: the last frame, without its escape codes.
  const shown = () =>
    (written.findLast((w) => w.startsWith("\u001b[H")) ?? "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: removing the frame's codes
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
      .split("\r\n")
      .map((l) => l.trimEnd());
  return { input, output, raw, written, shown };
}

function session(engine = fakeEngine(), size: [number, number] = [80, 24]) {
  const term = terminal(...size);
  const run = startInteractive({ engine, input: term.input, output: term.output, color: false, now: () => 0 });
  const type = async (...keys: string[]) => {
    for (const key of keys) {
      term.input.emit("data", key);
      await run.settled();
    }
  };
  return { ...term, run, engine, type };
}

describe("alden, interactive", () => {
  it("takes over the terminal, and gives it back as it was on q", async () => {
    const s = session();
    await s.run.settled();
    expect(s.written[0]).toBe(ENTER);
    expect(s.raw).toEqual([true]);
    expect(s.input.paused).toBe(false);
    await s.type("q");
    await s.run.done;
    expect(s.written.at(-1)).toBe(LEAVE);
    expect(s.raw).toEqual([true, false]);
    expect(s.input.paused).toBe(true);
    expect(s.input.listenerCount("data")).toBe(0);
    expect(s.output.listenerCount("resize")).toBe(0);
  });

  it("gives the terminal back on Ctrl-C from anywhere", async () => {
    const s = session();
    await s.type("\r", "c", "half a comm", "\u0003");
    await s.run.done;
    expect(s.written.at(-1)).toBe(LEAVE);
    expect(s.engine.calls.comment).toEqual([]);
  });

  it("goes from the queue to a briefing, marks a place, comments, and sends a review", async () => {
    const s = session();
    await s.run.settled();
    expect(s.engine.calls.queue).toEqual([false]);
    expect(s.shown()[3]).toMatch(/^› 1\. {2}acme\/api#12 {2}Charge cards in cen… {2}@sam {14}26h {6}\+120\/-10/);

    // j, j, k: the second PR; Enter briefs it.
    await s.type("j", "j", "\u001b[A", "\r");
    expect(s.engine.calls.brief).toEqual([{ pr: "acme/web#7", llm: false }]);
    expect(s.shown()).toContain("  Needs your eyes");

    // Place 2 is useful; a comment on it; then send it as Request changes, confirmed.
    await s.type("2", "u");
    expect(s.engine.calls.feedback.map((f) => f.kind === "verdict" && [f.item.title, f.verdict])).toEqual([
      ["Refunds round to the cent", "agree"],
    ]);
    expect(s.shown().at(-2)).toBe(" Marked 2 useful. 1 of 3: two more like this and Alden will put them first.");
    await s.type("c", "Round once, at the API", "\r");
    expect(s.engine.calls.comment).toEqual([
      { pr: "acme/web#7", body: "Round once, at the API", path: "src/refund.ts", line: 40 },
    ]);
    await s.type("s");
    expect(s.engine.calls.pending).toEqual(["acme/web#7"]);
    expect(s.shown()).toContain("  Review for acme/web#7: Comment");
    await s.type("x", "\r");
    expect(s.shown().at(-2)).toBe(" Send this review to GitHub as a request for changes?");
    expect(s.engine.calls.send).toEqual([]);
    await s.type("y");
    expect(s.engine.calls.send).toEqual([{ pr: "acme/web#7", event: "REQUEST_CHANGES" }]);

    // Back on a fresh queue, saying what was sent.
    expect(s.engine.calls.queue).toEqual([false, true]);
    expect(s.shown()[0]).toBe(" Alden  Your review queue · 4 PRs");
    expect(s.shown().at(-2)).toBe(" Sent: https://github.com/acme/api/pull/12#pullrequestreview-1 (1 comment).");
    await s.type("q");
    await s.run.done;
  });

  it("searches, opens on GitHub, and runs the model only when you say y", async () => {
    const s = session();
    await s.type("/", "bump", "\r", "o");
    expect(s.engine.calls.open).toEqual(["https://github.com/acme/api/pull/15"]);
    await s.type("\u001b", "\r", "m");
    expect(s.shown().at(-2)).toBe(" Run claude-sonnet? At most $0.50 a review; $1.20 of $10.00 spent today.");
    await s.type("n");
    expect(s.engine.calls.brief.map((b) => b.llm)).toEqual([false]);
    await s.type("m", "y");
    expect(s.engine.calls.brief).toEqual([
      { pr: "acme/api#12", llm: false },
      { pr: "acme/api#12", llm: true },
    ]);
    expect(s.shown()[0]).toBe(" Alden  acme/api#12 · with the model");
    expect(s.shown().at(-2)).toBe(" claude-sonnet read the change: $0.0042.");
    expect(s.shown()).toContain("  What it does");
    await s.type("\u001b", "q");
    await s.run.done;
  });

  it("redraws at the new size when the terminal is resized", async () => {
    const s = session();
    await s.run.settled();
    s.output.columns = 100;
    s.output.rows = 10;
    s.output.emit("resize");
    expect(s.shown()).toHaveLength(10);
    expect(s.shown()[2]).toMatch(/^ {2}#\s+PR\s+Title\s+Author/);
    await s.type("q");
  });

  it("shows why the queue couldn't load, and tries again on r", async () => {
    const s = session(fakeEngine({ failQueue: "Not signed in. Run `alden auth login`." }));
    await s.run.settled();
    expect(s.shown()[1]).toBe("  Not signed in. Run `alden auth login`.");
    await s.type("r");
    expect(s.engine.calls.queue).toEqual([false, true]);
    await s.type("q");
  });
});
