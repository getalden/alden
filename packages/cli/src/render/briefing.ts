import type { Anchor, Briefing, CheckResult } from "@alden/schema";
import { fit, paint, type RenderOptions, type Style, wrap } from "./style.js";

const MARK: Record<CheckResult["status"], { symbol: string; style: Style }> = {
  passed: { symbol: "✓", style: "green" },
  flagged: { symbol: "!", style: "yellow" },
  skipped: { symbol: "–", style: "dim" },
};

const SEVERITY_STYLE: Record<CheckResult["severity"], Style> = {
  high: "red",
  medium: "yellow",
  low: "dim",
  info: "dim",
};

/** Puts the line number where the text already names the file ("…: src/a.ts:10"), else prefixes the place. */
function withPlace(text: string, anchor: Anchor | undefined): string {
  if (!anchor) return text;
  const where = `${anchor.path}${anchor.line ? `:${anchor.line}` : ""}`;
  if (text.includes(anchor.path)) return anchor.line ? text.replace(anchor.path, where) : text;
  return `${where}  ${text}`;
}

/** "owner/repo#12  Title…", the title wrapping under itself; wraps plain text so colour codes don't count as width. */
function titleLines(ref: string, title: string, { width, color }: RenderOptions): string[] {
  const indent = " ".repeat(ref.length + 2);
  const [first = "", ...rest] = wrap(title, width - indent.length);
  return [`${paint(ref, "bold", color)}  ${first}`, ...rest.map((line) => `${indent}${line}`)];
}

function header(briefing: Briefing, options: RenderOptions): string[] {
  const { color } = options;
  const { summary, target } = briefing;
  const size =
    summary.reviewableAdditions !== summary.additions || summary.reviewableDeletions !== summary.deletions
      ? `+${summary.additions}/-${summary.deletions} (+${summary.reviewableAdditions}/-${summary.reviewableDeletions} without lockfiles)`
      : `+${summary.additions}/-${summary.deletions}`;
  const files = `${summary.files} file${summary.files === 1 ? "" : "s"}`;

  if (target.kind === "pr") {
    return [
      ...titleLines(`${target.repo}#${target.number}`, target.title, options),
      paint(`@${target.author ?? "ghost"} · ${target.baseRef} ← ${target.headRef} · ${files} · ${size}`, "dim", color),
      paint(target.url, "dim", color),
    ];
  }
  return [
    `${paint("Local changes", "bold", color)}${target.branch ? ` on ${target.branch}` : ""}`,
    paint(`${target.repoRoot} · ${files} · ${size} · compared with HEAD`, "dim", color),
  ];
}

/** The terminal briefing: where to look first, what was checked with evidence, and what wasn't checked. */
export function renderBriefing(briefing: Briefing, options: RenderOptions): string {
  const { color, width } = options;
  const out: string[] = [...header(briefing, options), ""];

  if (briefing.files.length === 0) {
    out.push("Nothing has changed, so there's nothing to review.");
    return `${out.join("\n")}\n`;
  }

  out.push(paint("Needs your eyes", "bold", color));
  if (briefing.needsYourEyes.length === 0) {
    out.push(...wrap("Nothing flagged. The checks below found nothing that needs a closer look.", width, "  "));
  }
  briefing.needsYourEyes.forEach((item, i) => {
    out.push(
      `  ${paint(`${i + 1}.`, "bold", color)} ${item.title}${item.anchor?.line ? paint(`:${item.anchor.line}`, "dim", color) : ""}`,
    );
    out.push(...wrap(item.reason, width, "     ").map((l) => paint(l, "dim", color)));
  });
  out.push("");

  out.push(paint("Checked", "bold", color));
  const titleWidth = Math.min(34, Math.max(...briefing.checks.map((c) => c.title.length + (c.heuristic ? 2 : 0))));
  for (const check of briefing.checks) {
    const mark = MARK[check.status];
    const title = fit(`${check.title}${check.heuristic ? " ~" : ""}`, titleWidth);
    const severity =
      check.status === "flagged"
        ? `${paint(check.severity.padEnd(6), SEVERITY_STYLE[check.severity], color)} `
        : "       ";
    // "  ! " + title + "  " + severity column (7) + " " = where the summary starts.
    const summaryColumn = titleWidth + 14;
    const [first = "", ...rest] = wrap(check.summary, width - summaryColumn);
    out.push(`  ${paint(mark.symbol, mark.style, color)} ${title}  ${severity} ${first}`);
    for (const line of rest) out.push(`${" ".repeat(summaryColumn)}${line}`);
    if (check.status === "flagged") {
      for (const evidence of check.evidence) {
        const text = withPlace(evidence.text, evidence.anchor);
        out.push(paint(fit(`      ${text}`, width).trimEnd(), "dim", color));
      }
    }
  }
  if (briefing.checks.some((c) => c.heuristic)) {
    out.push(paint("  ~ inferred from the diff alone, so it can be wrong", "dim", color));
  }
  out.push("");

  out.push(paint("Not checked", "bold", color));
  for (const item of briefing.notChecked)
    out.push(...wrap(item, width, "  · ").map((l, i) => (i === 0 ? l : `    ${l.slice(4)}`)));
  return `${out.join("\n")}\n`;
}
