import { formatAge, type RankedPullRequest, type RankedQueue } from "@alden/core";

export interface RenderOptions {
  /** Terminal width in columns. The title column absorbs whatever the fixed columns leave. */
  width: number;
  color: boolean;
}

const ANSI = { bold: [1, 22], dim: [2, 22], red: [31, 39], green: [32, 39], yellow: [33, 39] } as const;
type Style = keyof typeof ANSI;

function paint(text: string, style: Style, color: boolean): string {
  if (!color) return text;
  const [open, close] = ANSI[style];
  return `\u001b[${open}m${text}\u001b[${close}m`;
}

function fit(text: string, width: number): string {
  if (text.length <= width) return text.padEnd(width);
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** Shortens the repo, never the PR number: "acme/react-apollo-c…#25". */
function fitPr(repo: string, number: number, width: number): string {
  const label = `${repo}#${number}`;
  if (label.length <= width) return label.padEnd(width);
  const suffix = `…#${number}`;
  return `${repo.slice(0, Math.max(0, width - suffix.length))}${suffix}`;
}

const CI_LABEL = { success: "pass", failure: "fail", pending: "running", none: "–" } as const;
const CI_STYLE: Record<keyof typeof CI_LABEL, Style | undefined> = {
  success: "green",
  failure: "red",
  pending: "yellow",
  none: undefined,
};

interface Row {
  rank: number;
  item: RankedPullRequest;
}

/** The two-group queue table: a row per PR, and a dimmed line under it saying why it ranks where it does. */
export function renderQueue(ranked: RankedQueue, options: RenderOptions): string {
  const { color } = options;
  const rows: Row[] = [...ranked.needsYou, ...ranked.fastTrack].map((item, i) => ({ rank: i + 1, item }));
  if (rows.length === 0) return `Nothing is waiting on @${ranked.viewer}'s review.\n`;

  const prLabel = (r: Row) => `${r.item.pr.repo}#${r.item.pr.number}`;
  const cols = {
    rank: String(rows.length).length + 1,
    pr: Math.min(32, Math.max(2, ...rows.map((r) => prLabel(r).length))),
    author: Math.min(16, Math.max(6, ...rows.map((r) => (r.item.pr.author ?? "ghost").length + 1))),
    waiting: 7,
    size: Math.max(4, ...rows.map((r) => `+${r.item.pr.additions}/-${r.item.pr.deletions}`.length)),
    ci: 7,
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
    const main = [
      fit(`${rank}.`, cols.rank),
      fitPr(pr.repo, pr.number, cols.pr),
      fit(pr.title, titleWidth),
      fit(`@${pr.author ?? "ghost"}`, cols.author),
      fit(formatAge(item.waitingHours), cols.waiting),
      fit(`+${pr.additions}/-${pr.deletions}`, cols.size),
      ci,
    ].join("  ");
    // The Waiting column already shows the wait, so the reason line leaves it out (`--json` keeps it).
    const reasons = item.reasons.filter((r) => !r.startsWith("waiting "));
    const why = item.fastTrack ? item.fastTrack : reasons.join(" · ") || "nothing stands out";
    const indent = " ".repeat(cols.rank + 2);
    return `${main}\n${indent}${paint(fit(why, Math.max(20, options.width - indent.length)).trimEnd(), "dim", color)}`;
  };

  const out: string[] = [];
  for (const warning of ranked.warnings) out.push(paint(`Warning: ${warning}`, "yellow", color));
  if (ranked.warnings.length > 0) out.push("");

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
  out.push(paint("Open one with `alden open <#>`.", "dim", color));
  return `${out.join("\n")}\n`;
}

/** Colour only for a real terminal, and never when NO_COLOR is set (https://no-color.org). */
export function shouldColor(stream: NodeJS.WriteStream, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  return stream.isTTY === true && env.TERM !== "dumb";
}
