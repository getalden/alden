import {
  type Briefing,
  matchesSearch,
  type RankedPullRequest,
  type RankedQueue,
  type YourTurnItem,
} from "@alden/schema";
import { aldenNotKept, renderDrafts, renderSendSummary } from "../commands/comment.js";
import { renderBriefing } from "../render/briefing.js";
import { renderQueue } from "../render/queue.js";
import { paint, stripControl, wrap } from "../render/style.js";
import type { SendState } from "./state.js";

/**
 * Where things are on each screen, from the existing renderers' own lines: which lines are a queue row, and which are
 * a place to look in a briefing. The state machine moves through these; the view draws them.
 */

/** The title bar, the message line and the key line. */
export const CHROME = 3;
/** The columns left of every line: the cursor and a mark. */
export const GUTTER = 2;
/** The widest a briefing is drawn, as `alden review` draws it. */
const BRIEFING_MAX = 120;

export const bodyHeight = (height: number) => Math.max(1, height - CHROME);

/** The "Your turn" group: PRs you reviewed where something happened you haven't seen. */
export const yourTurnOf = (queue: RankedQueue): YourTurnItem[] => queue.yourTurn ?? [];

/** Every word in a Your turn PR's title or repo, or its #number, as `--search` matches a queue row. */
function matchesYourTurn(item: YourTurnItem, search: string): boolean {
  const text = `${item.title}\n${item.repo}`.toLowerCase();
  return search
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => {
      const number = /^#?(\d+)$/.exec(word);
      if (number && item.number === Number(number[1])) return true;
      return !word.startsWith("#") && text.includes(word);
    });
}

/** The queue with only the PRs whose title, repo, #number, author or branch has every word, as `--search` keeps. */
export function searchQueue(queue: RankedQueue, search: string): RankedQueue {
  if (!search.trim()) return queue;
  const keep = (rows: RankedPullRequest[]) => rows.filter((row) => matchesSearch(row.pr, search));
  return {
    ...queue,
    needsYou: keep(queue.needsYou),
    fastTrack: keep(queue.fastTrack),
    ...(queue.yourTurn ? { yourTurn: queue.yourTurn.filter((item) => matchesYourTurn(item, search)) } : {}),
  };
}

export interface QueueRow {
  /** "owner/repo#12" */
  pr: string;
  url: string;
  /** A Your turn row: opening it marks what happened as seen. */
  yourTurn: boolean;
  /** Its first and last line in `lines`. */
  start: number;
  end: number;
}

export interface QueueLayout {
  lines: string[];
  rows: QueueRow[];
}

/** Whether a line shows this PR: "acme/api#12", or the repo cut short, "acme/really-long-…#12". */
const showsPr = (line: string, repo: string, number: number) =>
  new RegExp(`#${number}(\\s|$)`).test(line) && (line.includes(`${repo}#`) || line.includes(`…#${number}`));

/**
 * The queue as `alden queue` prints it, and where each PR's row is. Your turn comes first, unnumbered: a row is its
 * PR, then an indented line saying what happened. Then the ranked rows, "N." with N counting through Needs you and
 * Fast-track, each with its dim reason line.
 */
export function queueLayout(
  queue: RankedQueue,
  search: string,
  width: number,
  color: boolean,
  /** The time Your turn's "2h ago" counts back from. */
  now?: number,
): QueueLayout {
  const shown = searchQueue(queue, search);
  const ranked = [...shown.needsYou, ...shown.fastTrack];
  const yourTurn = yourTurnOf(shown);
  const all = yourTurnOf(queue).length + queue.needsYou.length + queue.fastTrack.length;
  if (ranked.length + yourTurn.length === 0 && all > 0) {
    return { lines: [`No PRs match "${search.trim()}". Esc clears the search.`], rows: [] };
  }
  const render = (withColor: boolean) =>
    renderQueue(shown, { width: queueWidth(width), color: withColor, ...(now !== undefined ? { now } : {}) })
      .trimEnd()
      .split("\n");
  const lines = render(color);
  const plain = color ? render(false) : lines;
  const rows: QueueRow[] = [];
  const extent = (i: number, indent: string) => {
    let end = i;
    while (plain[end + 1]?.startsWith(indent) && !plain[end + 1]?.trim().startsWith("alden open <pr>")) end++;
    return end;
  };
  // Your turn: from its heading, each "  owner/repo#12  Title  2h ago" in order.
  const heading = plain.findIndex((line) => line.startsWith("Your turn ("));
  if (heading >= 0) {
    let next = 0;
    for (let i = heading + 1; i < plain.length && next < yourTurn.length; i++) {
      const item = yourTurn[next] as YourTurnItem;
      const line = plain[i] as string;
      if (!/^ {2}\S/.test(line) || !showsPr(line, item.repo, item.number)) continue;
      rows.push({ pr: item.pr, url: item.url, yourTurn: true, start: i, end: extent(i, "    ") });
      next++;
    }
  }
  plain.forEach((line, i) => {
    const rank = /^(\d+)\.\s/.exec(line);
    if (!rank) return;
    const byRank = ranked[Number(rank[1]) - 1];
    const item =
      byRank && showsPr(line, byRank.pr.repo, byRank.pr.number)
        ? byRank
        : ranked.find((r) => showsPr(line, r.pr.repo, r.pr.number));
    if (!item) return;
    rows.push({
      pr: `${item.pr.repo}#${item.pr.number}`,
      url: item.pr.url,
      yourTurn: false,
      start: i,
      end: extent(i, " "),
    });
  });
  return { lines, rows };
}

export interface Place {
  /** 1 for the first place under "Needs your eyes". */
  number: number;
  start: number;
  end: number;
}

export interface BriefingLayout {
  lines: string[];
  places: Place[];
}

/**
 * The width the renderers are given: never below what they can lay out (a narrower terminal cuts their lines), and a
 * briefing never wider than `alden review` draws it.
 */
const MIN_RENDER = 40;
export const briefingWidth = (width: number) => Math.max(MIN_RENDER, Math.min(width - GUTTER, BRIEFING_MAX));
const queueWidth = (width: number) => Math.max(MIN_RENDER, width - GUTTER);

/**
 * The briefing as `alden review` prints it, and the lines of each place under "Needs your eyes": its "N." line and
 * the indented lines under it.
 */
export function briefingLayout(briefing: Briefing, width: number, color: boolean): BriefingLayout {
  const render = (withColor: boolean) =>
    renderBriefing(briefing, { width: briefingWidth(width), color: withColor })
      .trimEnd()
      .split("\n");
  const lines = render(color);
  const plain = color ? render(false) : lines;
  const places: Place[] = [];
  const section = plain.indexOf("Needs your eyes");
  if (section >= 0) {
    for (let i = section + 1; i < plain.length && plain[i] !== ""; i++) {
      const number = /^ {2}(\d+)\. /.exec(plain[i] as string);
      if (!number) continue;
      let end = i;
      while (plain[end + 1]?.startsWith("     ")) end++;
      places.push({ number: Number(number[1]), start: i, end });
    }
  }
  return { lines, places };
}

/** The scroll that keeps lines `start` to `end` on screen, moving as little as it can. */
export function scrollTo(scroll: number, start: number, end: number, height: number): number {
  if (start < scroll) return start;
  if (end >= scroll + height) return Math.max(0, Math.min(start, end - height + 1));
  return scroll;
}

/** A scroll within `lines` lines on a screen `height` high. */
export const clampScroll = (scroll: number, lines: number, height: number) =>
  Math.max(0, Math.min(scroll, lines - height));

const VERDICT_LABELS = { COMMENT: "Comment", APPROVE: "Approve", REQUEST_CHANGES: "Request changes" } as const;

/**
 * The send screen: which review it is (Tab changes it), then exactly what `alden send` shows before it asks. With a
 * comment that can't be sent, the comments as `alden send` lists them then, and why it won't send.
 */
export function sendLayout(send: SendState, width: number, color: boolean): string[] {
  if (!send.data) return [];
  const { drafts, unaddressed, threads, unkept } = send.data;
  const choice = (Object.keys(VERDICT_LABELS) as (keyof typeof VERDICT_LABELS)[])
    .map((event) => {
      const label = VERDICT_LABELS[event];
      return event === send.event ? paint(`(•) ${label}`, "bold", color) : `( ) ${label}`;
    })
    .join("   ");
  const room = queueWidth(width);
  const lines = [`Send as:  ${choice}`, ""];
  if (unkept > 0) lines.push(...wrap(aldenNotKept(unkept, send.pr), room).map((l) => paint(l, "yellow", color)), "");
  const outdated = drafts.filter((d) => d.state === "outdated");
  const body =
    outdated.length > 0
      ? `${renderDrafts(send.pr, drafts, color)}\n${paint(`Not sent: ${outdated.map((d) => d.id).join(", ")} can't be sent until placed again or deleted.`, "red", color)}`
      : renderSendSummary({ pr: send.pr, event: send.event, drafts, unaddressed, threads }, color);
  lines.push(...body.trimEnd().split("\n"));
  // Comment text can be long: it wraps under its own indent rather than running off the screen (a long line loses
  // its colour, never its words).
  const out: string[] = [];
  for (const line of lines) {
    const plain = stripControl(line);
    if (plain.length <= room) out.push(line);
    else out.push(...wrap(plain.trim(), room, " ".repeat(plain.length - plain.trimStart().length)));
  }
  return out;
}
