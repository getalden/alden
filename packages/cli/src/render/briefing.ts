import type { Anchor, Briefing, CheckResult, LlmSection } from "@alden/schema";
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

const VERDICT_STYLE: Record<NonNullable<LlmSection["matchesTitle"]>["verdict"], Style> = {
  yes: "green",
  partly: "yellow",
  no: "red",
  unclear: "dim",
};

const place = (anchor: Anchor) => `${anchor.path}${anchor.line ? `:${anchor.line}` : ""}`;

/** The model's summary and whether the change matches its title, right under the header. */
function whatItDoes(llm: LlmSection, options: RenderOptions): string[] {
  const { color, width } = options;
  if (llm.status !== "ok" || !llm.summary) return [];
  const out = [paint("What it does", "bold", color), ...wrap(llm.summary, width, "  ")];
  if (llm.matchesTitle) {
    const verdict = paint(llm.matchesTitle.verdict, VERDICT_STYLE[llm.matchesTitle.verdict], color);
    const [first = "", ...rest] = wrap(`${llm.matchesTitle.reason}`, width - 22);
    out.push(`  Matches its title: ${verdict} · ${first}`, ...rest.map((l) => `${" ".repeat(20)}${l}`));
  }
  return [...out, ""];
}

/** The model's findings that didn't make "needs your eyes", most severe first. */
function alsoNoted(briefing: Briefing, options: RenderOptions): string[] {
  const { color, width } = options;
  const llm = briefing.llm;
  if (llm?.status !== "ok") return [];
  const shown = new Set(briefing.needsYourEyes.filter((i) => i.source === "llm").map((i) => i.title));
  const order = { high: 0, medium: 1, low: 2, info: 3 } as const;
  const rest = llm.findings.filter((f) => !shown.has(f.title)).sort((a, b) => order[a.severity] - order[b.severity]);
  if (rest.length === 0) return [];
  const out = [paint("Also noted by the model", "bold", color)];
  for (const finding of rest) {
    const where = finding.anchors[0] ? `  ${place(finding.anchors[0])}` : "";
    const more = finding.anchors.length > 1 ? ` +${finding.anchors.length - 1}` : "";
    out.push(
      `  ${paint(finding.severity.padEnd(6), SEVERITY_STYLE[finding.severity], color)} ${finding.title}${paint(`${where}${more}`, "dim", color)}`,
    );
    out.push(...wrap(finding.detail, width, "         ").map((l) => paint(l, "dim", color)));
  }
  return [...out, ""];
}

/** One line on the model: which, what it cost, what was dropped, or why it didn't run. */
function modelFooter(llm: LlmSection | undefined, options: RenderOptions): string[] {
  if (!llm) return [];
  const { color, width } = options;
  if (llm.status !== "ok") {
    const label = llm.status === "skipped" ? "Model not used" : `Model ${llm.status.replace("_", " ")}`;
    return ["", ...wrap(`${label}: ${llm.note ?? ""}`, width).map((l) => paint(l, "dim", color))];
  }
  const parts = [
    `Model: ${llm.model ?? "unknown"}${llm.provider ? ` via ${llm.provider}` : ""}${llm.effort ? ` (effort ${llm.effort})` : ""}`,
    llm.usd === undefined ? "cost unknown" : `$${llm.usd.toFixed(llm.usd < 0.01 ? 4 : 2)}`,
    llm.droppedFindings > 0 &&
      `${llm.droppedFindings} finding${llm.droppedFindings === 1 ? "" : "s"} dropped for pointing at lines not in the diff`,
    llm.redactedSecrets &&
      `${llm.redactedSecrets} likely secret${llm.redactedSecrets === 1 ? "" : "s"} hidden from the model`,
  ].filter(Boolean);
  return ["", ...wrap(parts.join(" · "), width).map((l) => paint(l, "dim", color))];
}

/** The terminal briefing: where to look first, what was checked with evidence, and what wasn't checked. */
export function renderBriefing(briefing: Briefing, options: RenderOptions): string {
  const { color, width } = options;
  const out: string[] = [...header(briefing, options), ""];

  if (briefing.files.length === 0) {
    out.push("Nothing has changed, so there's nothing to review.");
    return `${out.join("\n")}\n`;
  }

  if (briefing.llm) out.push(...whatItDoes(briefing.llm, options));

  out.push(paint("Needs your eyes", "bold", color));
  if (briefing.needsYourEyes.length === 0) {
    const text =
      briefing.llm?.status === "ok"
        ? "Nothing flagged. Neither the checks nor the model found anything that needs a closer look."
        : "Nothing flagged. The checks below found nothing that needs a closer look.";
    out.push(...wrap(text, width, "  "));
  }
  briefing.needsYourEyes.forEach((item, i) => {
    if (item.source === "llm") {
      // The model's titles don't name the file, so its place gets a line of its own.
      out.push(`  ${paint(`${i + 1}.`, "bold", color)} ${item.title}${paint(" (model)", "cyan", color)}`);
      if (item.anchor) out.push(paint(fit(`     ${place(item.anchor)}`, width).trimEnd(), "dim", color));
    } else {
      const line = item.anchor?.line ? paint(`:${item.anchor.line}`, "dim", color) : "";
      out.push(`  ${paint(`${i + 1}.`, "bold", color)} ${item.title}${line}`);
    }
    out.push(...wrap(item.reason, width, "     ").map((l) => paint(l, "dim", color)));
  });
  out.push("");
  out.push(...alsoNoted(briefing, options));

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
  out.push(...modelFooter(briefing.llm, options));
  return `${out.join("\n")}\n`;
}
