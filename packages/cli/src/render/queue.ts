import { formatAge, type RankedPullRequest, type RankedQueue, REREVIEW_REASON } from "@alden/core";
import type { FollowUpSummary, ScoreLine, YourTurnItem } from "@alden/schema";
import { fit, paint, type RenderOptions, type Style, stripControlDeep } from "./style.js";

export { type RenderOptions, shouldColor } from "./style.js";

/** Shortens the repo, never the PR number: "octocat/react-apollo-c…#25". */
function fitPr(repo: string, number: number, width: number): string {
  const label = `${repo}#${number}`;
  if (label.length <= width) return label.padEnd(width);
  const suffix = `…#${number}`;
  return `${repo.slice(0, Math.max(0, width - suffix.length))}${suffix}`;
}

const CI_LABEL = { success: "pass", failure: "fail", pending: "running", cancelled: "cancelled", none: "–" } as const;
const CI_STYLE: Record<keyof typeof CI_LABEL, Style | undefined> = {
  success: "green",
  failure: "red",
  pending: "yellow",
  cancelled: undefined,
  none: undefined,
};

/** `alden queue --explain`: the score line under each row. */
export interface QueueRenderOptions extends RenderOptions {
  explain?: boolean;
  /** For tests: the time "reviewed 2d ago" counts back from. */
  now?: number;
}

/** A number as the explain line shows it: no trailing zeros, at most two decimals. */
const num = (n: number) => String(Math.round(n * 100) / 100);

/**
 * "score 11.5: urgentLabel +6 · waiting +4.5 (×1.5) · ↑ your rule: payments/ first", named as `[queue.rank]` names
 * the weights, so you can see which one to change.
 */
export function explainLine(item: RankedPullRequest): string {
  const part = (line: ScoreLine) => {
    if (line.signal === "rule") return line.text;
    const points = line.points === 0 ? "0" : `${line.points > 0 ? "+" : "−"}${num(Math.abs(line.points))}`;
    const weight = line.weight !== undefined ? ` (×${num(line.weight)})` : "";
    const aside = line.points === 0 && line.signal === "learned" ? " (set aside: your rule decides)" : "";
    return `${line.signal} ${points}${weight}${aside}`;
  };
  const lines = item.breakdown ?? [];
  const failing = item.waitingOnAuthor ? " · after the others: CI failing" : "";
  return `score ${num(item.score.total)}${lines.length > 0 ? `: ${lines.map(part).join(" · ")}` : ""}${failing}`;
}

/**
 * "reviewed 2d ago · 3 of your 5 comments resolved": what's happened since you reviewed, for the reason line. The
 * counts only show once something has happened to your comments.
 */
export function followUpText(followUp: FollowUpSummary, now: number = Date.now()): string {
  const hours = Math.max(0, (now - Date.parse(followUp.lastReviewedAt)) / 3_600_000);
  const parts = [`reviewed ${formatAge(hours)} ago`];
  // What you haven't seen says it better than the counts.
  if (followUp.news) return [...parts, `new: ${followUp.news.text}`].join(" · ");
  if (followUp.yourThreads > 0 && followUp.resolved > 0) {
    parts.push(
      `${followUp.resolved} of your ${followUp.yourThreads} comment${followUp.yourThreads === 1 ? "" : "s"} resolved`,
    );
  }
  if (followUp.replied > 0) parts.push(`${followUp.replied} repl${followUp.replied === 1 ? "y" : "ies"} to you`);
  return parts.join(" · ");
}

interface Row {
  rank: number;
  item: RankedPullRequest;
}

/**
 * "Your turn": PRs you reviewed, off the queue, where something happened you haven't seen, with what and when. Not
 * numbered, so `alden open 3` still means the queue's third row: each is opened by its name.
 */
function renderYourTurn(items: YourTurnItem[], options: QueueRenderOptions): string[] {
  if (items.length === 0) return [];
  const { color } = options;
  const now = options.now ?? Date.now();
  const prWidth = Math.min(32, Math.max(...items.map((i) => `${i.repo}#${i.number}`.length)));
  const ageWidth = 8;
  const titleWidth = Math.max(20, options.width - 2 - prWidth - 2 - 2 - ageWidth);
  const indent = "    ";
  const out = [paint(`Your turn (${items.length})`, "bold", color)];
  for (const item of items) {
    const ago = `${formatAge(Math.max(0, (now - Date.parse(item.news.at)) / 3_600_000))} ago`;
    out.push(`  ${fitPr(item.repo, item.number, prWidth)}  ${fit(item.title, titleWidth)}  ${ago}`.trimEnd());
    out.push(
      `${indent}${paint(fit(item.news.text, Math.max(20, options.width - indent.length)).trimEnd(), "dim", color)}`,
    );
  }
  out.push(paint(`${indent}alden open <pr> or alden review <pr> opens one, and it leaves Your turn.`, "dim", color));
  out.push("");
  return out;
}

/** The two-group queue table: a row per PR, and a dimmed line under it saying why it ranks where it does. */
export function renderQueue(untrusted: RankedQueue, options: QueueRenderOptions): string {
  // Titles, authors, labels and repos come from GitHub users: no control characters reach the terminal.
  const ranked = stripControlDeep(untrusted);
  const { color } = options;
  const rows: Row[] = [...ranked.needsYou, ...ranked.fastTrack].map((item, i) => ({ rank: i + 1, item }));
  // Warnings matter most when the queue is empty: an org hiding its PRs looks exactly like nothing to review.
  const warningLines = ranked.warnings.map((w) => paint(`Warning: ${w}`, "yellow", options.color));
  const yourTurn = renderYourTurn(ranked.yourTurn ?? [], options);
  if (rows.length === 0) {
    return [
      ...yourTurn,
      `Nothing is waiting on @${ranked.viewer}'s review.`,
      ...(warningLines.length ? ["", ...warningLines] : []),
    ]
      .join("\n")
      .concat("\n");
  }

  const prLabel = (r: Row) => `${r.item.pr.repo}#${r.item.pr.number}`;
  const cols = {
    rank: String(rows.length).length + 1,
    pr: Math.min(32, Math.max(2, ...rows.map((r) => prLabel(r).length))),
    author: Math.min(16, Math.max(6, ...rows.map((r) => (r.item.pr.author ?? "ghost").length + 1))),
    waiting: 7,
    size: Math.max(4, ...rows.map((r) => `+${r.item.pr.additions}/-${r.item.pr.deletions}`.length)),
    ci: 9,
  };
  const gaps = 2 * 6;
  const fixed = cols.rank + cols.pr + cols.author + cols.waiting + cols.size + cols.ci + gaps;
  const titleWidth = Math.max(20, options.width - fixed);

  const header = [
    fit("#", cols.rank),
    fit("PR", cols.pr),
    fit("Title", titleWidth),
    fit("Author", cols.author),
    fit("Waiting", cols.waiting),
    fit("Size", cols.size),
    "CI",
  ].join("  ");

  const line = ({ rank, item }: Row): string => {
    const { pr } = item;
    const ciStyle = CI_STYLE[pr.ci];
    const ci = ciStyle ? paint(CI_LABEL[pr.ci], ciStyle, color) : CI_LABEL[pr.ci];
    // A draft says so before its title and is dimmed, like the web UI's chip; a re-review says so too.
    const rereview = item.followUp?.rereviewRequestedAt !== undefined;
    const main = [
      fit(`${rank}.`, cols.rank),
      fitPr(pr.repo, pr.number, cols.pr),
      fit(`${pr.isDraft ? "[Draft] " : ""}${rereview ? "[Re-review] " : ""}${pr.title}`, titleWidth),
      fit(`@${pr.author ?? "ghost"}`, cols.author),
      fit(formatAge(item.waitingHours), cols.waiting),
      fit(`+${pr.additions}/-${pr.deletions}`, cols.size),
      ci,
    ].join("  ");
    // The Waiting column already shows the wait, so the reason line leaves it out (`--json` keeps it).
    const reasons = item.reasons.filter((r) => !r.startsWith("waiting "));
    // Likewise the tag already says it's a draft.
    if (pr.isDraft && reasons.includes("draft")) reasons.splice(reasons.indexOf("draft"), 1);
    // And the re-review tag: the line says when you reviewed instead.
    if (reasons.includes(REREVIEW_REASON)) reasons.splice(reasons.indexOf(REREVIEW_REASON), 1);
    if (item.followUp) reasons.unshift(followUpText(item.followUp, options.now));
    const why = item.fastTrack ? item.fastTrack : reasons.join(" · ") || "nothing stands out";
    const indent = " ".repeat(cols.rank + 2);
    // The explain line isn't cut to the width: it's there to be read in full.
    const explain = options.explain ? `\n${indent}${paint(explainLine(item), "cyan", color)}` : "";
    return `${pr.isDraft ? paint(main, "dim", color) : main}\n${indent}${paint(fit(why, Math.max(20, options.width - indent.length)).trimEnd(), "dim", color)}${explain}`;
  };

  const out: string[] = [];
  out.push(...warningLines);
  if (warningLines.length > 0) out.push("");
  out.push(...yourTurn);

  const groups: [string, Row[]][] = [
    ["Needs you", rows.filter((r) => r.item.lane === "needs-you")],
    ["Fast-track", rows.filter((r) => r.item.lane === "fast-track")],
  ];
  for (const [title, group] of groups) {
    if (group.length === 0) continue;
    out.push(paint(`${title} (${group.length})`, "bold", color));
    out.push(paint(header.trimEnd(), "dim", color));
    for (const row of group) out.push(line(row));
    out.push("");
  }
  // A terminal also gets a "Next:" line from the command (see next.ts).
  return `${out.join("\n").trimEnd()}\n`;
}
