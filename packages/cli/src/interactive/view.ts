import { paint, wrap } from "../render/style.js";
import {
  bodyHeight,
  briefingLayout,
  CHROME,
  clampScroll,
  GUTTER,
  queueLayout,
  sendLayout,
  yourTurnOf,
} from "./layout.js";
import type { Busy, State } from "./state.js";

/**
 * Draws a state as the screen's lines: a title bar, the screen's body, a message line and the keys you can press.
 * Exactly `height` lines; the terminal cuts each to its width. Pure, so screens can be tested as strings.
 */

export interface ViewOptions {
  color: boolean;
  now: number;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Smaller than this, nothing useful fits: the screen says so instead. */
export const MIN_WIDTH = 40;
export const MIN_HEIGHT = 8;

/** "⠹ Checking acme/api#12… 3s", as the CLI's spinner says it. */
function spinner(busy: Busy, state: State, now: number): string {
  const seconds = Math.max(0, Math.floor((now - busy.startedAt) / 1000));
  return `${FRAMES[state.tick % FRAMES.length]} ${busy.label} ${seconds}s`;
}

const KEYS = {
  queue: "j/k move  / search  enter brief  o open  r refresh  q quit",
  briefing: "j/k move  1-9 place  u/n useful/not  c comment  s send  m model  esc back",
  send: "tab review type  j/k scroll  enter send  esc back",
  search: "type to search title, repo, #number, author  enter keep  esc clear",
  comment: "enter save  esc cancel  ctrl-u clear",
  model: "y run the model  any other key cancels",
  confirm: "y send to GitHub  any other key goes back",
};

function title(state: State, { color }: ViewOptions): string {
  const where =
    state.screen === "queue"
      ? queueTitle(state)
      : state.screen === "briefing"
        ? `${state.briefing?.pr ?? ""}${state.briefing?.llm ? " · with the model" : ""}`
        : `${state.send?.pr ?? ""} · send your review`;
  return paint(` Alden  ${where}`, "bold", color);
}

function queueTitle(state: State): string {
  const data = state.queue.data;
  if (!data) return "Your review queue";
  const total = yourTurnOf(data).length + data.needsYou.length + data.fastTrack.length;
  const search = state.queue.search.trim();
  const matching = search ? ` · matching "${search}"` : "";
  return `Your review queue · ${total} PR${total === 1 ? "" : "s"}${matching}`;
}

/** The body's lines before scrolling, and the gutter for each. */
function body(state: State, options: ViewOptions): string[] {
  const { color, now } = options;
  const height = bodyHeight(state.height);
  const slice = (lines: string[], scroll: number) => lines.slice(scroll, scroll + height);
  const room = state.width - GUTTER;
  const problem = (error: string, hint: string) => [
    ...wrap(error, room, "  ").map((l) => paint(l, "red", color)),
    "",
    paint(`  ${hint}`, "dim", color),
  ];

  if (state.screen === "queue") {
    const q = state.queue;
    if (!q.data) {
      if (q.error) return problem(q.error, "r tries again · q quits");
      return q.busy ? [`  ${spinner(q.busy, state, now)}`] : [];
    }
    const { lines, rows } = queueLayout(q.data, q.search, state.width, color);
    const row = rows[q.selected];
    const marked = lines.map((line, i) => {
      if (row && i === row.start) return `${paint("›", "bold", color)} ${color ? `\u001b[7m${line}\u001b[27m` : line}`;
      return `  ${line}`;
    });
    return slice(marked, clampScroll(q.scroll, marked.length, height));
  }

  if (state.screen === "briefing") {
    const b = state.briefing;
    if (!b) return [];
    if (!b.data) {
      if (b.error) return problem(b.error, "esc goes back to the queue");
      return b.busy ? [`  ${spinner(b.busy, state, now)}`] : [];
    }
    const { lines, places } = briefingLayout(b.data, state.width, color);
    const under = places.find((p) => b.cursor >= p.start && b.cursor <= p.end);
    const marked = lines.map((line, i) => {
      const cursor = i === b.cursor ? paint("›", "bold", color) : " ";
      const place = places.find((p) => p.start === i);
      const verdict = place ? b.verdicts[place.number] : undefined;
      const mark =
        verdict === "agree"
          ? paint("✓", "green", color)
          : verdict === "not_needed"
            ? paint("✗", "red", color)
            : under && i >= under.start && i <= under.end
              ? paint("│", "cyan", color)
              : " ";
      return `${cursor}${mark}${line}`;
    });
    return slice(marked, clampScroll(b.scroll, marked.length, height));
  }

  const s = state.send;
  if (!s) return [];
  if (!s.data) {
    if (s.error) return problem(s.error, "esc goes back to the briefing");
    return s.busy ? [`  ${spinner(s.busy, state, now)}`] : [];
  }
  const lines = sendLayout(s, state.width, color).map((l) => `  ${l}`);
  return slice(lines, clampScroll(s.scroll, lines.length, height));
}

/** The line above the keys (or lines, joined by newlines): a prompt being typed, something under way, or what just happened. */
function messageLine(state: State, options: ViewOptions): string {
  const { color, now } = options;
  const prompt = state.prompt;
  if (prompt?.kind === "search") return ` / ${prompt.text}${paint("█", "dim", color)}`;
  if (prompt?.kind === "comment") {
    const lead = ` Comment on ${prompt.where}: `;
    // The end of a long comment stays in view as you type.
    const room = Math.max(10, state.width - lead.length - 2);
    const shown = prompt.text.length > room ? `…${prompt.text.slice(-(room - 1))}` : prompt.text;
    return `${paint(lead, "bold", color)}${shown}${paint("█", "dim", color)}`;
  }
  if (prompt?.kind === "model") {
    const c = prompt.choice;
    const usd = (n: number) => `$${n.toFixed(2)}`;
    return paint(
      ` Run ${c.model}? At most ${usd(c.perReviewUsd)} a review; ${usd(c.spentToday)} of ${usd(c.dailyUsd)} spent today.`,
      "yellow",
      color,
    );
  }
  if (state.screen === "send" && state.send?.confirming) {
    const names = { COMMENT: "a comment", APPROVE: "an approval", REQUEST_CHANGES: "a request for changes" };
    return paint(` Send this review to GitHub as ${names[state.send.event]}?`, "yellow", color);
  }
  const busy =
    state.screen === "queue"
      ? state.queue.data && state.queue.busy
      : state.screen === "briefing"
        ? state.briefing?.data && state.briefing.busy
        : state.send?.data && state.send.busy;
  if (busy) return ` ${spinner(busy, state, now)}`;
  const m = state.message;
  if (!m) return "";
  const style = m.tone === "error" ? "red" : m.tone === "ok" ? "green" : "dim";
  // A long message (GitHub's errors say how to fix them) wraps onto the lines above, up to three.
  return wrap(m.text, state.width - 2, " ")
    .slice(0, 3)
    .map((line) => paint(line, style, color))
    .join("\n");
}

function keysLine(state: State): string {
  const prompt = state.prompt?.kind;
  if (prompt) return ` ${KEYS[prompt]}`;
  if (state.screen === "send" && state.send?.confirming) return ` ${KEYS.confirm}`;
  return ` ${KEYS[state.screen]}`;
}

export function view(state: State, options: ViewOptions): string[] {
  const { color } = options;
  if (state.width < MIN_WIDTH || state.height < MIN_HEIGHT) {
    const lines = wrap(
      "Alden needs a bigger terminal: at least 80 by 24 works best. Ctrl-C quits.",
      state.width - 1,
      " ",
    );
    return [...lines, ...Array(Math.max(0, state.height - lines.length)).fill("")].slice(0, state.height);
  }
  const height = bodyHeight(state.height);
  const lines = body(state, options);
  const message = messageLine(state, options).split("\n");
  const room = height - (message.length - 1);
  const padded = [...lines, ...Array(Math.max(0, room - lines.length)).fill("")].slice(0, room);
  const out = [title(state, options), ...padded, ...message, paint(keysLine(state), "dim", color)];
  return out.slice(0, Math.max(state.height, CHROME));
}
