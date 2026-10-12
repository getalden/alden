import type { RankedQueue } from "@alden/schema";
import { describe, expect, it } from "vitest";
import { briefing, draft, queue, row, withModel } from "./__fixtures__/fake.js";
import { wantsInteractive } from "./app.js";
import { keyFrom } from "./keys.js";
import { queueLayout } from "./layout.js";
import { type Effect, type Event, initialState, placeAtCursor, type State, update } from "./state.js";

/** Runs events (or keys, as "j", "enter") from a state, collecting every effect asked for. */
function play(from: State, ...steps: (string | Event)[]): [State, Effect[]] {
  let state = from;
  const effects: Effect[] = [];
  for (const step of steps) {
    const event: Event = typeof step === "string" ? { type: "key", key: keyFrom(step) } : step;
    const [next, asked] = update(state, event, 1_000);
    state = next;
    effects.push(...asked);
  }
  return [state, effects];
}

const start = (width = 80, height = 24) => initialState(width, height, 0)[0];
const loaded = (q: RankedQueue = queue) => play(start(), { type: "queue-loaded", queue: q })[0];
/** The briefing of the first PR, loaded. */
const briefed = (b = briefing()) => {
  const [state, effects] = play(loaded(), "enter");
  const id = (effects[0] as Extract<Effect, { type: "brief" }>).id;
  return play(state, { type: "briefing-loaded", id, briefing: b })[0];
};

describe("the queue screen", () => {
  it("starts by loading the queue, and shows what GitHub is doing", () => {
    const [state, effects] = initialState(80, 24, 0);
    expect(effects).toEqual([{ type: "load-queue", refresh: false }]);
    const [next] = play(state, { type: "queue-progress", label: "Checking acme/api (1 of 2)…" });
    expect(next.queue.busy?.label).toBe("Checking acme/api (1 of 2)…");
  });

  it("moves with j/k and the arrows, never past the first or last row", () => {
    expect(play(loaded(), "k")[0].queue.selected).toBe(0);
    expect(play(loaded(), "j", "down", "j")[0].queue.selected).toBe(3);
    expect(play(loaded(), "j", "j", "j", "j", "j")[0].queue.selected).toBe(3);
    expect(play(loaded(), "G", "up")[0].queue.selected).toBe(2);
    expect(play(loaded(), "G", "g")[0].queue.selected).toBe(0);
  });

  it("briefs the selected PR on Enter, without the model", () => {
    const [state, effects] = play(loaded(), "j", "enter");
    expect(state.screen).toBe("briefing");
    expect(state.briefing?.pr).toBe("acme/web#7");
    expect(state.briefing?.busy?.label).toBe("Checking acme/web#7…");
    expect(effects).toEqual([{ type: "brief", id: 1, pr: "acme/web#7", llm: false }]);
  });

  it("opens the selected PR on GitHub with o, refreshes with r, and quits with q", () => {
    expect(play(loaded(), "o")[1]).toEqual([{ type: "open", url: "https://github.com/acme/api/pull/12" }]);
    const [refreshing, effects] = play(loaded(), "r");
    expect(effects).toEqual([{ type: "load-queue", refresh: true }]);
    expect(refreshing.queue.data).toBe(queue);
    expect(refreshing.queue.busy).toBeDefined();
    expect(play(loaded(), "q")[0].quit).toBe(true);
  });

  it("searches as you type, by title, repo, #number or author; Esc puts the search back", () => {
    const [typing] = play(loaded(), "/", "l", "e", "e");
    expect(typing.prompt).toEqual({ kind: "search", text: "lee", before: "" });
    expect(queueLayout(queue, typing.queue.search, 80, false).rows.map((r) => r.item.pr.number)).toEqual([7]);
    expect(play(loaded(), "/", "#", "3", "1", "enter")[0].queue.search).toBe("#31");
    const [kept] = play(loaded(), "/", "a", "p", "i", "enter");
    expect(kept.prompt).toBeUndefined();
    expect(kept.queue.search).toBe("api");
    expect(play(kept, "/", "x", "escape")[0].queue.search).toBe("api");
    // Esc on the queue clears a search kept.
    expect(play(kept, "escape")[0].queue.search).toBe("");
  });

  it("keeps the selection on a row after the search narrows the queue", () => {
    const [state] = play(loaded(), "G", "/", "l", "o", "d", "a", "s", "h");
    expect(state.queue.selected).toBe(0);
    const [, effects] = play(state, "enter", "enter");
    expect(effects).toEqual([{ type: "brief", id: 1, pr: "acme/api#15", llm: false }]);
  });

  it("says why when the queue couldn't load, and keeps a queue it has when a refresh fails", () => {
    const [failed] = play(start(), { type: "queue-failed", error: "GitHub said 401." });
    expect(failed.queue.error).toBe("GitHub said 401.");
    const [kept] = play(loaded(), "r", { type: "queue-failed", error: "Offline." });
    expect(kept.queue.data).toBe(queue);
    expect(kept.message).toEqual({ text: "Offline.", tone: "error" });
  });

  it("scrolls to keep the selected row on a short screen", () => {
    const many: RankedQueue = { ...queue, needsYou: Array.from({ length: 30 }, (_, i) => row(i + 1)), fastTrack: [] };
    const [state] = play(play(start(80, 12), { type: "queue-loaded", queue: many })[0], "G");
    const rows = queueLayout(many, "", 80, false).rows;
    const last = rows.at(-1);
    expect(state.queue.scroll).toBeGreaterThan(0);
    expect((last?.end ?? 0) - state.queue.scroll).toBeLessThan(12 - 3);
  });
});

describe("the briefing screen", () => {
  it("drops a briefing that arrives after you've gone back", () => {
    const [state, effects] = play(loaded(), "enter", "escape");
    const id = (effects[0] as Extract<Effect, { type: "brief" }>).id;
    const [after] = play(state, { type: "briefing-loaded", id, briefing: briefing() });
    expect(after.screen).toBe("queue");
    expect(after.briefing).toBeUndefined();
  });

  it("goes to a place by its number, and knows the place under the cursor", () => {
    const state = briefed();
    expect(placeAtCursor(state)).toBeUndefined();
    const [two] = play(state, "2");
    expect(placeAtCursor(two)).toBe(2);
    expect(placeAtCursor(play(two, "j")[0])).toBe(2);
    expect(placeAtCursor(play(two, "k")[0])).toBe(1);
    expect(play(state, "9")[0].message).toEqual({
      text: "There's no place 9; this briefing has 2.",
      tone: "error",
    });
  });

  it("marks the place under the cursor useful or not useful, and the same mark again takes it back", () => {
    const [, effects] = play(briefed(), "1", "u");
    expect(effects).toEqual([
      {
        type: "feedback",
        place: 1,
        verdict: "agree",
        input: {
          kind: "verdict",
          target: { kind: "pr", repo: "acme/api", number: 12 },
          briefingAt: "2026-10-12T10:05:00Z",
          item: {
            source: "check",
            checkId: "signatures.changed",
            title: "charge() changed: still called from src/cart.ts",
            severity: "high",
            anchor: { path: "src/pay.ts", line: 12 },
            placement: "eyes",
          },
          verdict: "agree",
        },
      },
    ]);
    const [marked] = play(briefed(), "2", { type: "feedback-saved", place: 2, verdict: "not_needed" });
    expect(marked.briefing?.verdicts).toEqual({ 2: "not_needed" });
    expect(marked.message?.text).toBe("Marked 2 not useful.");
    const [, again] = play(marked, "n");
    expect((again[0] as Extract<Effect, { type: "feedback" }>).verdict).toBe("clear");
  });

  it("asks you to pick a place before marking one", () => {
    const [state, effects] = play(briefed(), "u");
    expect(effects).toEqual([]);
    expect(state.message?.tone).toBe("error");
  });

  it("writes a comment on the place under the cursor, or a general note elsewhere", () => {
    const [typing] = play(briefed(), "2", "c", "U", "s", "e", "backspace", "e", " ", "c", "e", "n", "t", "s");
    expect(typing.prompt).toEqual({ kind: "comment", text: "Use cents", where: "src/refund.ts:40", place: 2 });
    const [, effects] = play(typing, "enter");
    expect(effects).toEqual([
      { type: "comment", input: { pr: "acme/api#12", body: "Use cents", path: "src/refund.ts", line: 40 } },
    ]);
    const [, note] = play(briefed(), "c", "H", "i", "enter");
    expect(note).toEqual([{ type: "comment", input: { pr: "acme/api#12", body: "Hi" } }]);
    const [cancelled, none] = play(briefed(), "c", "x", "escape");
    expect(none).toEqual([]);
    expect(cancelled.message?.text).toBe("Comment not saved.");
  });

  it("keys typed into a comment are text, not commands", () => {
    const [state, effects] = play(briefed(), "c", "q", "s", "m", "u");
    expect(state.screen).toBe("briefing");
    expect(state.quit).toBe(false);
    expect(effects).toEqual([]);
    expect(state.prompt).toMatchObject({ text: "qsmu" });
  });

  it("scrolls with space and b a screen at a time, and g/G to the ends", () => {
    const state = briefed();
    const [down] = play(state, " ");
    expect(down.briefing?.cursor).toBeGreaterThan(0);
    expect(play(down, "b")[0].briefing?.cursor).toBe(0);
    const [end] = play(state, "G");
    expect(end.briefing?.scroll).toBeGreaterThan(0);
    expect(play(end, "g")[0].briefing).toMatchObject({ cursor: 0, scroll: 0 });
  });

  it("runs the model only after saying which and what it may cost, and says what it cost", () => {
    const [checking, effects] = play(briefed(), "m");
    expect(effects).toEqual([{ type: "check-model" }]);
    const choice = {
      available: true,
      model: "claude-sonnet",
      perReviewUsd: 0.5,
      dailyUsd: 10,
      spentToday: 1.2,
    } as const;
    const [asking] = play(checking, { type: "model-checked", choice });
    expect(asking.prompt).toEqual({ kind: "model", choice });
    expect(play(asking, "n")[1]).toEqual([]);
    const [running, run] = play(asking, "y");
    expect(run).toEqual([{ type: "brief", id: 2, pr: "acme/api#12", llm: true }]);
    expect(running.briefing?.busy?.label).toBe("Reviewing acme/api#12 with claude-sonnet…");
    const [done] = play(running, { type: "briefing-loaded", id: 2, briefing: withModel() });
    expect(done.message?.text).toBe("claude-sonnet read the change: $0.0042.");
  });

  it("says why there's no model to run", () => {
    const [state] = play(briefed(), "m", {
      type: "model-checked",
      choice: { available: false, reason: "No model is set up. Run `alden setup`." },
    });
    expect(state.prompt).toBeUndefined();
    expect(state.message?.text).toBe("No model to run: No model is set up. Run `alden setup`.");
  });

  it("goes back to the queue with Esc, keeping the queue's selection", () => {
    const [state] = play(loaded(), "j", "enter", "escape");
    expect(state.screen).toBe("queue");
    expect(state.queue.selected).toBe(1);
  });
});

describe("the send screen", () => {
  const pending = { drafts: [draft()], unaddressed: [], threads: [], unkept: 0 };
  const sending = () => {
    const [state, effects] = play(briefed(), "s");
    expect(effects).toEqual([{ type: "load-pending", pr: "acme/api#12" }]);
    return play(state, { type: "pending-loaded", pr: "acme/api#12", pending })[0];
  };

  it("chooses Comment, Approve or Request changes", () => {
    expect(sending().send?.event).toBe("COMMENT");
    expect(play(sending(), "tab")[0].send?.event).toBe("APPROVE");
    expect(play(sending(), "tab", "tab", "tab")[0].send?.event).toBe("COMMENT");
    expect(play(sending(), "backtab")[0].send?.event).toBe("REQUEST_CHANGES");
    expect(play(sending(), "a", "x")[0].send?.event).toBe("REQUEST_CHANGES");
  });

  it("sends only after Enter and then y", () => {
    const [confirming, none] = play(sending(), "a", "enter");
    expect(none).toEqual([]);
    expect(confirming.send?.confirming).toBe(true);
    expect(play(confirming, "y")[1]).toEqual([{ type: "send", pr: "acme/api#12", event: "APPROVE" }]);
    const [cancelled, nothing] = play(confirming, "enter");
    expect(nothing).toEqual([]);
    expect(cancelled.send?.confirming).toBe(false);
    expect(cancelled.message?.text).toBe("Not sent. Your comments are still here.");
  });

  it("refuses to send a comment that's outdated, as alden send does", () => {
    const [state] = play(briefed(), "s", {
      type: "pending-loaded",
      pr: "acme/api#12",
      pending: { ...pending, drafts: [draft({ id: "d9", state: "outdated" })] },
    });
    const [after, effects] = play(state, "enter");
    expect(effects).toEqual([]);
    expect(after.send?.confirming).toBe(false);
    expect(after.message?.text).toBe("Not sent: d9 can't be sent until placed again or deleted.");
  });

  it("says what was sent and goes back to a fresh queue", () => {
    const [state, effects] = play(sending(), "enter", "y", {
      type: "sent",
      result: { url: "https://github.com/acme/api/pull/12#r1", posted: 1, review: "COMMENT" },
    });
    expect(effects.at(-1)).toEqual({ type: "load-queue", refresh: true });
    expect(state.screen).toBe("queue");
    expect(state.message).toEqual({ text: "Sent: https://github.com/acme/api/pull/12#r1 (1 comment).", tone: "ok" });
  });

  it("goes back to the briefing with Esc", () => {
    expect(play(sending(), "escape")[0].screen).toBe("briefing");
  });
});

describe("everywhere", () => {
  it("quits on Ctrl-C, even while typing", () => {
    expect(play(loaded(), "/", "a", "ctrl-c")[0].quit).toBe(true);
    expect(play(briefed(), "c", "ctrl-c")[0].quit).toBe(true);
  });

  it("keeps the selection on screen when the terminal is resized", () => {
    const [state] = play(loaded(), "G", { type: "resize", width: 100, height: 10 });
    expect(state.width).toBe(100);
    const row = queueLayout(queue, "", 100, false).rows[3];
    expect(row && row.end - state.queue.scroll).toBeLessThan(10 - 3);
  });
});

describe("wantsInteractive", () => {
  const tty = { isTTY: true };
  it("is on for a terminal both ways", () => {
    expect(wantsInteractive(tty, tty, { TERM: "xterm-256color" })).toBe(true);
  });
  it("is off for a pipe, in CI, and on a dumb terminal", () => {
    expect(wantsInteractive({ isTTY: false }, tty, {})).toBe(false);
    expect(wantsInteractive(tty, {}, {})).toBe(false);
    expect(wantsInteractive(tty, tty, { CI: "true" })).toBe(false);
    expect(wantsInteractive(tty, tty, { CI: "false" })).toBe(true);
    expect(wantsInteractive(tty, tty, { TERM: "dumb" })).toBe(false);
  });
});
