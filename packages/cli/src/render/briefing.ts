import type { Anchor, Briefing, CheckResult, Evidence, LlmSection, RelatedFile } from "@alden/schema";
import { fit, paint, type RenderOptions, type Style, stripControlDeep, wrap } from "./style.js";

const MARK: Record<CheckResult["status"], { symbol: string; style: Style }> = {
  passed: { symbol: "✓", style: "green" },
  flagged: { symbol: "!", style: "yellow" },
  skipped: { symbol: "–", style: "dim" },
};

const SEVERITY_STYLE: Record<CheckResult["severity"], Style> = {
  critical: "red",
  high: "red",
  medium: "yellow",
  low: "dim",
  info: "dim",
};

/** A severity in a fixed-width column; critical is bold as well as red, so it stands out from high. */
function severityLabel(severity: CheckResult["severity"], color: boolean): string {
  const label = paint(severity.padEnd(8), SEVERITY_STYLE[severity], color);
  return severity === "critical" ? paint(label, "bold", color) : label;
}

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

/** "Look at these too: src/cli.ts:2 (caller), src/rank.test.ts:9 (test)", for a place's related files. */
export const lookAtTheseToo = (related: RelatedFile[], wrapPath: (where: string) => string = (w) => w) =>
  `Look at these too: ${related.map((r) => `${wrapPath(`${r.path}${r.line ? `:${r.line}` : ""}`)} (${r.why})`).join(", ")}`;

const place = (anchor: Anchor) => `${anchor.path}${anchor.line ? `:${anchor.line}` : ""}`;

/** Files the change moved or renamed, with where from: the diff alone shows them as a new path. */
function moves(briefing: Briefing, { color }: RenderOptions): string[] {
  const moved = briefing.files.filter((f) => f.previousPath);
  if (moved.length === 0) return [];
  const shown = moved.slice(0, 5).map((f) => {
    const edits = f.additions + f.deletions === 0 ? "no edits" : `+${f.additions}/-${f.deletions}`;
    return `  ${f.path} ${paint(`moved from ${f.previousPath} (${edits})`, "dim", color)}`;
  });
  const more = moved.length > 5 ? [paint(`  and ${moved.length - 5} more`, "dim", color)] : [];
  return [paint("Moved", "bold", color), ...shown, ...more, ""];
}

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
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
  const rest = llm.findings.filter((f) => !shown.has(f.title)).sort((a, b) => order[a.severity] - order[b.severity]);
  if (rest.length === 0) return [];
  const out = [paint("Also noted by the model", "bold", color)];
  for (const finding of rest) {
    const where = finding.anchors[0] ? `  ${place(finding.anchors[0])}` : "";
    const more = finding.anchors.length > 1 ? ` +${finding.anchors.length - 1}` : "";
    out.push(`  ${severityLabel(finding.severity, color)} ${finding.title}${paint(`${where}${more}`, "dim", color)}`);
    out.push(...wrap(finding.detail, width, "           ").map((l) => paint(l, "dim", color)));
    if (finding.fromNote) {
      out.push(
        ...wrap(`Because of your note: ${finding.fromNote.text}`, width, "           ").map((l) =>
          paint(l, "cyan", color),
        ),
      );
    }
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
  return [
    "",
    ...wrap(parts.join(" · "), width).map((l) => paint(l, "dim", color)),
    ...(llm.draftsNote ? wrap(llm.draftsNote, width).map((l) => paint(l, "yellow", color)) : []),
  ];
}

/**
 * What a PR briefing's callers were found in: "Callers from main at abc1234 + this PR" for a graph built on GitHub's
 * merge, or the PR's branch at its head when there was no merge to use.
 */
export function briefedAgainst(briefing: Briefing): string | undefined {
  const target = briefing.target;
  if (target.kind !== "pr" || !target.graphFrom) return undefined;
  const short = (sha: string | undefined) => sha?.slice(0, 7);
  if (target.graphFrom === "merge" && target.baseSha)
    return `Callers from ${target.baseRef} at ${short(target.baseSha)} + this PR`;
  return `Callers from the PR's branch${target.headSha ? ` at ${short(target.headSha)}` : ""}, not ${target.baseRef} as it is now`;
}

/** The terminal briefing: where to look first, what was checked with evidence, and what wasn't checked. */
/** What your feedback left out, and how many of your notes the model saw: learning is never silent. */
function learnedNote(briefing: Briefing, { width, color }: RenderOptions): string[] {
  const learning = briefing.learning;
  if (!learning) return [];
  const out: string[] = [];
  const byReason = new Map<string, typeof learning.hidden>();
  for (const item of learning.hidden) byReason.set(item.reason, [...(byReason.get(item.reason) ?? []), item]);
  for (const [reason, items] of byReason) {
    const what =
      items.length === 1
        ? `${items[0]?.title}`
        : `${items.length} places (${items
            .slice(0, 2)
            .map((i) => i.anchor?.path ?? i.title)
            .join(", ")}${items.length > 2 ? ` +${items.length - 2}` : ""})`;
    out.push(...wrap(`Hidden: ${what}. ${reason}.`, width, "  ").map((l) => paint(l, "dim", color)));
  }
  if (learning.memory > 0) {
    const notes = `${learning.memory} note${learning.memory === 1 ? "" : "s"}`;
    out.push(paint(`  The model was given ${notes} on what you care about here (\`alden memory\`).`, "dim", color));
  }
  return out;
}

/** Splits text into lines of at most `columns` (at least one), breaking at spaces where it can: each line's [start, end). */
function breakLines(text: string, columns: number): [number, number][] {
  // At least a column a line, so a very narrow terminal still moves through the text.
  const room = Math.max(1, columns);
  const lines: [number, number][] = [];
  let start = 0;
  while (text.length - start > room) {
    const space = text.lastIndexOf(" ", start + room);
    let end = space > start ? space : start + room;
    let next = end;
    while (end > start && text[end - 1] === " ") end--;
    while (text[next] === " ") next++;
    lines.push([start, end]);
    start = next;
  }
  lines.push([start, text.length]);
  return lines;
}

/** Where two signatures differ, widened to whole words: [start, end) in each. */
function changedSpan(before: string, after: string): { before: [number, number]; after: [number, number] } {
  const word = (c: string | undefined) => c !== undefined && /\w/.test(c);
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  while (head > 0 && word(before[head - 1]) && (word(before[head]) || word(after[head]))) head--;
  let tail = 0;
  const most = Math.min(before.length, after.length) - head;
  while (tail < most && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const fromEnd = (text: string) => text.length - tail;
  while (
    tail > 0 &&
    word(before[fromEnd(before)]) &&
    (word(before[fromEnd(before) - 1]) || word(after[fromEnd(after) - 1]))
  )
    tail--;
  return { before: [head, before.length - tail], after: [head, after.length - tail] };
}

/** One side of a changed signature, "- old" or "+ new", wrapped under itself with the changed part in colour. */
function signatureLines(
  sign: "-" | "+",
  signature: string,
  [from, to]: [number, number],
  { width, color }: RenderOptions,
): string[] {
  const indent = "        ";
  const style: Style = sign === "-" ? "red" : "green";
  return breakLines(signature, Math.max(20, width - indent.length - 2)).map(([start, end], i) => {
    const parts = [
      [start, Math.min(end, Math.max(start, from))],
      [Math.max(start, from), Math.min(end, to)],
      [Math.max(start, to), end],
    ] as const;
    const text = parts
      .map(([a, b], part) => (b > a ? paint(signature.slice(a, b), part === 1 ? style : "dim", color) : ""))
      .join("");
    return `${indent}${paint(i === 0 ? `${sign} ` : "  ", "dim", color)}${text}`;
  });
}

/**
 * A flagged check's evidence, wrapped rather than cut at the terminal's edge. A changed signature gets its old and new
 * forms on lines of their own, the part that changed in colour.
 */
function evidenceLines(evidence: Evidence, options: RenderOptions): string[] {
  const { width, color } = options;
  // Spacing kept, so "path:line  text" stays apart; continuation lines sit two further in.
  const hang = (text: string) =>
    breakLines(text, width - 8).map(([start, end], i) =>
      paint(`${i === 0 ? "      " : "        "}${text.slice(start, end)}`, "dim", color),
    );
  const text = evidence.text.replace(/\s*\n\s*/g, " ");
  const signature = /^(compatible change|changed): (.+) → (.+)$/.exec(text);
  if (!signature) return hang(withPlace(text, evidence.anchor));
  const [, kind = "", before = "", after = ""] = signature;
  const span = changedSpan(before, after);
  return [
    ...hang(withPlace(`${kind}:`, evidence.anchor)),
    ...signatureLines("-", before, span.before, options),
    ...signatureLines("+", after, span.after, options),
  ];
}

export function renderBriefing(untrusted: Briefing, options: RenderOptions): string {
  // Titles, paths, evidence and model text come from PR authors and the model: no control characters reach the terminal.
  const briefing = stripControlDeep(untrusted);
  const { color, width } = options;
  const out: string[] = [...header(briefing, options), ""];

  if (briefing.files.length === 0) {
    out.push("Nothing has changed, so there's nothing to review.");
    return `${out.join("\n")}\n`;
  }

  out.push(...moves(briefing, options));
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
    if (item.learned) out.push(...wrap(`↑ ${item.learned}`, width, "     ").map((l) => paint(l, "cyan", color)));
    if (item.fromNote) {
      out.push(
        ...wrap(`Because of your note: ${item.fromNote.text}`, width, "     ").map((l) => paint(l, "cyan", color)),
      );
    }
    if (item.related?.length) out.push(...wrap(lookAtTheseToo(item.related), width, "     "));
  });
  out.push(...learnedNote(briefing, options));
  out.push("");
  out.push(...alsoNoted(briefing, options));

  out.push(paint("Checked", "bold", color));
  const titleWidth = Math.min(34, Math.max(...briefing.checks.map((c) => c.title.length + (c.heuristic ? 2 : 0))));
  for (const check of briefing.checks) {
    const mark = MARK[check.status];
    const title = fit(`${check.title}${check.heuristic ? " ~" : ""}`, titleWidth);
    const severity = check.status === "flagged" ? `${severityLabel(check.severity, color)} ` : "         ";
    // "  ! " + title + "  " + severity column (9) + " " = where the summary starts.
    const summaryColumn = titleWidth + 16;
    const [first = "", ...rest] = wrap(check.summary, width - summaryColumn);
    out.push(`  ${paint(mark.symbol, mark.style, color)} ${title}  ${severity} ${first}`);
    for (const line of rest) out.push(`${" ".repeat(summaryColumn)}${line}`);
    const quiet = briefing.learning?.quietened?.find((q) => q.checkId === check.id);
    if (quiet) out.push(paint(fit(`      ↓ ${quiet.reason}`, width).trimEnd(), "cyan", color));
    if (check.status === "flagged") {
      for (const evidence of check.evidence) out.push(...evidenceLines(evidence, options));
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
  const against = briefedAgainst(briefing);
  if (against) out.push(...(briefing.llm ? [] : [""]), ...wrap(against, width).map((l) => paint(l, "dim", color)));
  return `${out.join("\n")}\n`;
}
