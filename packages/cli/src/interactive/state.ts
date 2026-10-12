import type { Briefing, FeedbackInput, RankedQueue, ReviewDraft, ReviewEvent, SendReviewResult } from "@alden/schema";
import { draftedLines, sentLines } from "../commands/comment.js";
import { briefingPlaces } from "../mcp/render.js";
import type { DraftInput } from "../ui/server.js";
import type { ModelChoice, PendingReview } from "./engine.js";
import type { Key } from "./keys.js";
import { bodyHeight, briefingLayout, clampScroll, queueLayout, scrollTo, sendLayout } from "./layout.js";

/**
 * The interactive view as a state machine: `update` takes the state and an event (a key, a resize, an answer from
 * Alden) and returns the next state and what to ask Alden for. It never waits or draws, so every screen and key can
 * be tested without a terminal.
 */

/** Something under way, and since when, for the spinner's clock. */
export interface Busy {
  label: string;
  startedAt: number;
}

export interface QueueState {
  data?: RankedQueue;
  busy?: Busy;
  error?: string;
  /** Index into the rows shown (after the search). */
  selected: number;
  scroll: number;
  search: string;
}

export type Verdict = "agree" | "not_needed";

export interface BriefingState {
  /** Which brief request this is, so an answer for a briefing you've left is dropped. */
  id: number;
  pr: string;
  url: string;
  /** Whether the latest request asked the model. */
  llm: boolean;
  data?: Briefing;
  busy?: Busy;
  error?: string;
  /** The line the cursor is on. */
  cursor: number;
  scroll: number;
  /** Your marks on places, by place number. */
  verdicts: Record<number, Verdict>;
}

export const VERDICTS: ReviewEvent[] = ["COMMENT", "APPROVE", "REQUEST_CHANGES"];

export interface SendState {
  pr: string;
  data?: PendingReview;
  busy?: Busy;
  error?: string;
  event: ReviewEvent;
  scroll: number;
  /** Asking "send this?": only y sends. */
  confirming: boolean;
}

export type Prompt =
  | { kind: "search"; text: string; before: string }
  | { kind: "comment"; text: string; place?: number; where: string }
  | { kind: "model"; choice: Extract<ModelChoice, { available: true }> };

export interface Message {
  text: string;
  tone: "info" | "ok" | "error";
}

export interface State {
  screen: "queue" | "briefing" | "send";
  width: number;
  height: number;
  queue: QueueState;
  briefing?: BriefingState;
  send?: SendState;
  prompt?: Prompt;
  message?: Message;
  quit: boolean;
  /** Spinner frames drawn so far. */
  tick: number;
  nextId: number;
}

export type Event =
  | { type: "key"; key: Key }
  | { type: "resize"; width: number; height: number }
  | { type: "tick" }
  | { type: "queue-progress"; label: string }
  | { type: "queue-loaded"; queue: RankedQueue }
  | { type: "queue-failed"; error: string }
  | { type: "briefing-progress"; id: number; label: string }
  | { type: "briefing-loaded"; id: number; briefing: Briefing }
  | { type: "briefing-failed"; id: number; error: string }
  | { type: "model-checked"; choice: ModelChoice }
  | { type: "feedback-saved"; place: number; verdict: Verdict | "clear"; progress?: string }
  | { type: "feedback-failed"; error: string }
  | { type: "comment-saved"; pr: string; draft: ReviewDraft }
  | { type: "comment-failed"; error: string }
  | { type: "pending-loaded"; pr: string; pending: PendingReview }
  | { type: "pending-failed"; pr: string; error: string }
  | { type: "sent"; result: SendReviewResult }
  | { type: "send-failed"; error: string };

export type Effect =
  | { type: "load-queue"; refresh: boolean }
  | { type: "brief"; id: number; pr: string; llm: boolean }
  | { type: "check-model" }
  | { type: "feedback"; place: number; verdict: Verdict | "clear"; input: FeedbackInput }
  | { type: "comment"; input: DraftInput }
  | { type: "load-pending"; pr: string }
  | { type: "send"; pr: string; event: ReviewEvent }
  | { type: "open"; url: string };

type Step = [State, Effect[]];

export const QUEUE_LOADING = "Asking GitHub who you are…";

/** Where a session starts: the queue, loading. */
export function initialState(width: number, height: number, now: number): Step {
  return [
    {
      screen: "queue",
      width,
      height,
      queue: { busy: { label: QUEUE_LOADING, startedAt: now }, selected: 0, scroll: 0, search: "" },
      quit: false,
      tick: 0,
      nextId: 1,
    },
    [{ type: "load-queue", refresh: false }],
  ];
}

/** The queue rows on screen now, after the search. */
const rowsOf = (state: State) =>
  state.queue.data ? queueLayout(state.queue.data, state.queue.search, state.width, false).rows : [];

/** The queue with its selection inside the rows and on screen. */
function settleQueue(state: State): State {
  const rows = rowsOf(state);
  const selected = Math.max(0, Math.min(state.queue.selected, rows.length - 1));
  const row = rows[selected];
  const height = bodyHeight(state.height);
  const scroll = !row
    ? 0
    : selected === 0
      ? 0
      : scrollTo(state.queue.scroll, Math.max(0, row.start - 1), row.end, height);
  return { ...state, queue: { ...state.queue, selected, scroll } };
}

const briefingLines = (state: State, briefing: Briefing) => briefingLayout(briefing, state.width, false);

/** The briefing with its cursor inside the briefing and on screen. */
function settleBriefing(state: State): State {
  const b = state.briefing;
  if (!b?.data) return state;
  const { lines } = briefingLines(state, b.data);
  const height = bodyHeight(state.height);
  const cursor = Math.max(0, Math.min(b.cursor, lines.length - 1));
  const scroll = clampScroll(scrollTo(b.scroll, cursor, cursor, height), lines.length, height);
  return { ...state, briefing: { ...b, cursor, scroll } };
}

/** The place the briefing's cursor is on, if any. */
export function placeAtCursor(state: State): number | undefined {
  const b = state.briefing;
  if (!b?.data) return undefined;
  return briefingLines(state, b.data).places.find((p) => b.cursor >= p.start && b.cursor <= p.end)?.number;
}

const ask = (state: State, text: string, tone: Message["tone"] = "info"): State => ({
  ...state,
  message: { text, tone },
});

export function update(state: State, event: Event, now: number): Step {
  switch (event.type) {
    case "key": {
      // A key clears the last message, unless it's typed into a prompt.
      const { message: _, ...cleared } = state;
      return onKey(state.prompt ? state : cleared, event.key, now);
    }
    case "resize": {
      const sized = { ...state, width: event.width, height: event.height };
      return [settleBriefing(settleQueue(sized)), []];
    }
    case "tick":
      return [{ ...state, tick: state.tick + 1 }, []];
    case "queue-progress":
      return state.queue.busy
        ? [{ ...state, queue: { ...state.queue, busy: { ...state.queue.busy, label: event.label } } }, []]
        : [state, []];
    case "queue-loaded": {
      const { busy: _, error: __, ...queue } = state.queue;
      return [settleQueue({ ...state, queue: { ...queue, data: event.queue } }), []];
    }
    case "queue-failed": {
      const { busy: _, ...queue } = state.queue;
      // With a queue on screen, it stays, and the error is a message.
      if (queue.data) return [ask({ ...state, queue }, event.error, "error"), []];
      return [{ ...state, queue: { ...queue, error: event.error } }, []];
    }
    case "briefing-progress": {
      const b = state.briefing;
      if (b?.id !== event.id || !b.busy) return [state, []];
      return [{ ...state, briefing: { ...b, busy: { ...b.busy, label: event.label } } }, []];
    }
    case "briefing-loaded": {
      const b = state.briefing;
      if (b?.id !== event.id) return [state, []];
      const { busy: _, error: __, ...rest } = b;
      const next = settleBriefing({ ...state, briefing: { ...rest, data: event.briefing, verdicts: {} } });
      return [b.llm ? ask(next, modelOutcome(event.briefing), "info") : next, []];
    }
    case "briefing-failed": {
      const b = state.briefing;
      if (b?.id !== event.id) return [state, []];
      const { busy: _, ...rest } = b;
      if (rest.data) return [ask({ ...state, briefing: rest }, event.error, "error"), []];
      return [{ ...state, briefing: { ...rest, error: event.error } }, []];
    }
    case "model-checked":
      if (state.screen !== "briefing") return [state, []];
      if (!event.choice.available) return [ask(state, `No model to run: ${event.choice.reason}`, "error"), []];
      return [{ ...state, prompt: { kind: "model", choice: event.choice } }, []];
    case "feedback-saved": {
      const b = state.briefing;
      if (!b) return [state, []];
      const verdicts = { ...b.verdicts };
      if (event.verdict === "clear") delete verdicts[event.place];
      else verdicts[event.place] = event.verdict;
      const said =
        event.verdict === "clear"
          ? `Took back your mark on ${event.place}.`
          : `Marked ${event.place} ${event.verdict === "agree" ? "useful" : "not useful"}.`;
      return [
        ask({ ...state, briefing: { ...b, verdicts } }, `${said}${event.progress ? ` ${event.progress}` : ""}`, "ok"),
        [],
      ];
    }
    case "feedback-failed":
      return [ask(state, `Couldn't save that feedback: ${event.error}`, "error"), []];
    case "comment-saved": {
      const said = draftedLines(event.draft, event.pr).join(" ").replace(/:$/, ". s sends your review.");
      return [ask(state, said, "ok"), []];
    }
    case "comment-failed":
      return [ask(state, `Not saved: ${event.error}`, "error"), []];
    case "pending-loaded": {
      const s = state.send;
      if (s?.pr !== event.pr) return [state, []];
      const { busy: _, ...rest } = s;
      return [{ ...state, send: { ...rest, data: event.pending } }, []];
    }
    case "pending-failed": {
      const s = state.send;
      if (s?.pr !== event.pr) return [state, []];
      const { busy: _, ...rest } = s;
      return [{ ...state, send: { ...rest, error: event.error } }, []];
    }
    case "sent": {
      // Sent: back to the queue, asked for again, since the PR has likely left it.
      const { send: _, briefing: __, ...rest } = state;
      const next: State = {
        ...rest,
        screen: "queue",
        queue: { ...state.queue, busy: { label: QUEUE_LOADING, startedAt: now } },
      };
      return [ask(next, sentLines(event.result, false).join(" "), "ok"), [{ type: "load-queue", refresh: true }]];
    }
    case "send-failed": {
      const s = state.send;
      if (!s) return [ask(state, `Not sent: ${event.error}`, "error"), []];
      const { busy: _, ...rest } = s;
      return [ask({ ...state, send: rest }, `Not sent: ${event.error}`, "error"), []];
    }
  }
}

/** What the model run came to: its cost, or why it didn't run. */
function modelOutcome(briefing: Briefing): string {
  const llm = briefing.llm;
  if (!llm) return "The model wasn't asked.";
  if (llm.status !== "ok") return `The model didn't run: ${llm.note ?? llm.status}`;
  const cost = llm.usd === undefined ? "cost unknown" : `$${llm.usd.toFixed(llm.usd < 0.01 ? 4 : 2)}`;
  return `${llm.model ?? "The model"} read the change: ${cost}.`;
}

function onKey(state: State, key: Key, now: number): Step {
  if (key.name === "ctrl-c") return [{ ...state, quit: true }, []];
  if (state.prompt) return onPrompt(state, state.prompt, key, now);
  if (state.screen === "send") return onSendKey(state, key, now);
  if (state.screen === "briefing") return onBriefingKey(state, key, now);
  return onQueueKey(state, key, now);
}

const is = (key: Key, ...names: string[]) =>
  names.some((n) => (n.length === 1 ? key.name === "char" && key.text === n : key.name === n));

/** Typing into a prompt line: text, Backspace, Ctrl-U to clear. True when the key was one of those. */
function edit(text: string, key: Key): string | undefined {
  if (key.name === "char") return text + (key.text ?? "");
  if (key.name === "backspace") return [...text].slice(0, -1).join("");
  if (key.name === "ctrl-u") return "";
  return undefined;
}

function onPrompt(state: State, prompt: Prompt, key: Key, now: number): Step {
  const { prompt: _, ...closed } = state;
  if (prompt.kind === "model") {
    const b = state.briefing;
    if (!is(key, "y") || !b) return [ask(closed, "The model wasn't run."), []];
    const id = state.nextId;
    const busy = { label: `Reviewing ${b.pr} with ${prompt.choice.model}…`, startedAt: now };
    return [
      { ...closed, nextId: id + 1, briefing: { ...b, id, llm: true, busy } },
      [{ type: "brief", id, pr: b.pr, llm: true }],
    ];
  }
  if (prompt.kind === "search") {
    if (key.name === "enter") return [closed, []];
    if (key.name === "escape") {
      return [settleQueue({ ...closed, queue: { ...state.queue, search: prompt.before, selected: 0, scroll: 0 } }), []];
    }
    const text = edit(prompt.text, key);
    if (text === undefined) return [state, []];
    return [
      settleQueue({
        ...state,
        prompt: { ...prompt, text },
        queue: { ...state.queue, search: text, selected: 0, scroll: 0 },
      }),
      [],
    ];
  }
  // A comment.
  if (key.name === "escape") return [ask(closed, "Comment not saved."), []];
  if (key.name === "enter") {
    const b = state.briefing;
    if (!prompt.text.trim() || !b) return [ask(closed, "Nothing saved: the comment was empty."), []];
    const anchor = prompt.place !== undefined ? b.data?.needsYourEyes[prompt.place - 1]?.anchor : undefined;
    const input: DraftInput = {
      pr: b.pr,
      body: prompt.text,
      ...(anchor ? { path: anchor.path, ...(anchor.line ? { line: anchor.line } : {}) } : {}),
    };
    return [ask(closed, `Saving the comment on ${prompt.where}…`), [{ type: "comment", input }]];
  }
  const text = edit(prompt.text, key);
  return text === undefined ? [state, []] : [{ ...state, prompt: { ...prompt, text } }, []];
}

function onQueueKey(state: State, key: Key, now: number): Step {
  const q = state.queue;
  const rows = rowsOf(state);
  const page = Math.max(1, Math.floor(bodyHeight(state.height) / 2));
  const move = (selected: number): Step => [settleQueue({ ...state, queue: { ...q, selected } }), []];
  if (is(key, "q")) return [{ ...state, quit: true }, []];
  if (is(key, "r")) {
    const { error: _, ...rest } = q;
    return [
      { ...state, queue: { ...rest, busy: { label: QUEUE_LOADING, startedAt: now } } },
      [{ type: "load-queue", refresh: true }],
    ];
  }
  if (is(key, "/")) return [{ ...state, prompt: { kind: "search", text: q.search, before: q.search } }, []];
  if (is(key, "escape") && q.search) {
    return [settleQueue({ ...state, queue: { ...q, search: "", selected: 0, scroll: 0 } }), []];
  }
  if (is(key, "j", "down")) return move(q.selected + 1);
  if (is(key, "k", "up")) return move(q.selected - 1);
  if (is(key, "pagedown", " ")) return move(q.selected + page);
  if (is(key, "pageup", "b")) return move(q.selected - page);
  if (is(key, "g", "home")) return move(0);
  if (is(key, "G", "end")) return move(rows.length - 1);
  const row = rows[q.selected];
  if (!row) return [state, []];
  const pr = `${row.item.pr.repo}#${row.item.pr.number}`;
  if (is(key, "o")) return [ask(state, `Opening ${row.item.pr.url}`), [{ type: "open", url: row.item.pr.url }]];
  if (is(key, "enter", "l", "right")) {
    const id = state.nextId;
    const briefing: BriefingState = {
      id,
      pr,
      url: row.item.pr.url,
      llm: false,
      busy: { label: `Checking ${pr}…`, startedAt: now },
      cursor: 0,
      scroll: 0,
      verdicts: {},
    };
    return [{ ...state, screen: "briefing", nextId: id + 1, briefing }, [{ type: "brief", id, pr, llm: false }]];
  }
  return [state, []];
}

function backToQueue(state: State): Step {
  const { briefing: _, ...rest } = state;
  return [settleQueue({ ...rest, screen: "queue" }), []];
}

function onBriefingKey(state: State, key: Key, now: number): Step {
  const b = state.briefing;
  if (!b) return backToQueue(state);
  if (is(key, "escape", "q", "h", "left", "backspace")) return backToQueue(state);
  if (is(key, "o")) return [ask(state, `Opening ${b.url}`), [{ type: "open", url: b.url }]];
  if (!b.data || b.busy) return [state, []];
  const briefing = b.data;
  const { lines, places } = briefingLines(state, briefing);
  const height = bodyHeight(state.height);
  const go = (cursor: number, scroll = b.scroll): Step => [
    settleBriefing({ ...state, briefing: { ...b, cursor, scroll } }),
    [],
  ];
  if (is(key, "j", "down")) return go(b.cursor + 1);
  if (is(key, "k", "up")) return go(b.cursor - 1);
  if (is(key, " ", "pagedown", "ctrl-d")) {
    const scroll = clampScroll(b.scroll + height, lines.length, height);
    return go(Math.min(lines.length - 1, b.cursor + (scroll - b.scroll || height)), scroll);
  }
  if (is(key, "b", "pageup")) {
    const scroll = clampScroll(b.scroll - height, lines.length, height);
    return go(Math.max(0, b.cursor - (b.scroll - scroll || height)), scroll);
  }
  if (is(key, "g", "home")) return go(0, 0);
  if (is(key, "G", "end")) return go(lines.length - 1, lines.length);
  if (key.name === "char" && key.text && /^[1-9]$/.test(key.text)) {
    const place = places.find((p) => p.number === Number(key.text));
    if (!place) {
      const none =
        places.length === 0
          ? "This briefing has no places to look."
          : `There's no place ${key.text}; this briefing has ${places.length}.`;
      return [ask(state, none, "error"), []];
    }
    // The whole place on screen, scrolling as little as it can.
    return go(place.start, scrollTo(b.scroll, place.start, place.end, height));
  }
  if (is(key, "u", "n")) {
    const place = placeAtCursor(state);
    if (place === undefined) {
      return [
        ask(state, "Put the cursor on a place under Needs your eyes (or press its number) to mark it.", "error"),
        [],
      ];
    }
    const item = briefingPlaces(briefing).get(`E${place}`);
    if (!item) return [state, []];
    const wanted: Verdict = is(key, "u") ? "agree" : "not_needed";
    // The same mark again takes it back, as in `alden ui`.
    const verdict = b.verdicts[place] === wanted ? "clear" : wanted;
    const target = briefing.target;
    if (target.kind !== "pr") return [state, []];
    const input: FeedbackInput = {
      kind: "verdict",
      target: { kind: "pr", repo: target.repo, number: target.number },
      briefingAt: briefing.generatedAt,
      ...(briefing.llm?.status === "ok" && briefing.llm.model ? { model: briefing.llm.model } : {}),
      item,
      verdict,
    };
    return [state, [{ type: "feedback", place, verdict, input }]];
  }
  if (is(key, "c")) {
    const place = placeAtCursor(state);
    const anchor = place !== undefined ? briefing.needsYourEyes[place - 1]?.anchor : undefined;
    const where = anchor ? `${anchor.path}${anchor.line ? `:${anchor.line}` : ""}` : "the PR (a general note)";
    return [{ ...state, prompt: { kind: "comment", text: "", where, ...(place !== undefined ? { place } : {}) } }, []];
  }
  if (is(key, "s")) {
    const send: SendState = {
      pr: b.pr,
      event: "COMMENT",
      scroll: 0,
      confirming: false,
      busy: { label: "Reading your comments…", startedAt: now },
    };
    return [{ ...state, screen: "send", send }, [{ type: "load-pending", pr: b.pr }]];
  }
  if (is(key, "m")) return [ask(state, "Checking which model is set up…"), [{ type: "check-model" }]];
  return [state, []];
}

/** Drafts that can't be sent until placed again or deleted, as `alden send` refuses them. */
export const outdatedOf = (send: SendState) => send.data?.drafts.filter((d) => d.state === "outdated") ?? [];

function onSendKey(state: State, key: Key, now: number): Step {
  const s = state.send;
  if (!s) return [{ ...state, screen: "briefing" }, []];
  const set = (change: Partial<SendState>): Step => [{ ...state, send: { ...s, ...change } }, []];
  if (s.confirming) {
    if (is(key, "y")) {
      return [
        {
          ...state,
          send: { ...s, confirming: false, busy: { label: "Sending your review to GitHub…", startedAt: now } },
        },
        [{ type: "send", pr: s.pr, event: s.event }],
      ];
    }
    return [ask({ ...state, send: { ...s, confirming: false } }, "Not sent. Your comments are still here."), []];
  }
  if (is(key, "escape", "q", "backspace")) {
    const { send: _, ...rest } = state;
    return [{ ...rest, screen: "briefing" }, []];
  }
  if (s.busy) return [state, []];
  const at = VERDICTS.indexOf(s.event);
  if (is(key, "tab", "right", "l")) return set({ event: VERDICTS[(at + 1) % VERDICTS.length] as ReviewEvent });
  if (is(key, "backtab", "left", "h")) {
    return set({ event: VERDICTS[(at + VERDICTS.length - 1) % VERDICTS.length] as ReviewEvent });
  }
  if (is(key, "c")) return set({ event: "COMMENT" });
  if (is(key, "a")) return set({ event: "APPROVE" });
  if (is(key, "x")) return set({ event: "REQUEST_CHANGES" });
  const height = bodyHeight(state.height);
  const lines = sendLayout(s, state.width, false).length;
  const scroll = (to: number) => set({ scroll: clampScroll(to, lines, height) });
  if (is(key, "j", "down")) return scroll(s.scroll + 1);
  if (is(key, "k", "up")) return scroll(s.scroll - 1);
  if (is(key, " ", "pagedown")) return scroll(s.scroll + height);
  if (is(key, "b", "pageup")) return scroll(s.scroll - height);
  if (is(key, "g", "home")) return scroll(0);
  if (is(key, "G", "end")) return scroll(lines);
  if (is(key, "enter")) {
    if (!s.data) return [state, []];
    const outdated = outdatedOf(s);
    if (outdated.length > 0) {
      return [
        ask(
          state,
          `Not sent: ${outdated.map((d) => d.id).join(", ")} can't be sent until placed again or deleted.`,
          "error",
        ),
        [],
      ];
    }
    return set({ confirming: true });
  }
  return [state, []];
}
