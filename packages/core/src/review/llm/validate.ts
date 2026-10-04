import type { Anchor, LlmFinding } from "@alden/schema";
import type { DiffFile } from "../../diff/parse.js";
import { MODEL_TOPICS } from "../../learn/learn.js";
import type { LlmOutput } from "./prompt.js";

/**
 * Lines the model could legitimately point at: added and context lines of the files it was shown, by new-file
 * number. A deleted file has no new lines, so only whole-file anchors work there.
 */
function visibleLines(files: DiffFile[]): Map<string, Set<number>> {
  const index = new Map<string, Set<number>>();
  for (const file of files) {
    const lines = new Set<number>();
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) if (line.newLine !== undefined) lines.add(line.newLine);
    }
    index.set(file.path, lines);
  }
  return index;
}

/** "CI is failing on this branch" and the like, with nothing added. "CI is failing — missing import in x.go" passes. */
export function restatesCi(title: string): boolean {
  return /^(the )?(ci|checks?|build|tests?)( is| are)? (failing|failed|red|broken|pending)( on (this|the) (pr|branch|commit|latest commit))?\.?$/i.test(
    title.trim(),
  );
}

export interface ValidatedFindings {
  findings: LlmFinding[];
  /** Findings thrown away because every place they named was outside what the model saw. */
  dropped: number;
}

/**
 * Keeps only what can be checked against the diff. Each anchor must name a file the model was shown, and a line in
 * that file's visible hunks when it gives one. A finding whose anchors all fail is dropped as invented; a finding
 * with no anchors at all (e.g. "the title promises X") is kept as a general note.
 */
export function validateFindings(output: LlmOutput, shownFiles: DiffFile[]): ValidatedFindings {
  const index = visibleLines(shownFiles);
  const findings: LlmFinding[] = [];
  let dropped = 0;

  for (const finding of output.findings) {
    // The prompt says not to; this catches the bare restatement while keeping findings that name a cause.
    if (restatesCi(finding.title)) continue;
    const valid: Anchor[] = [];
    for (const anchor of finding.anchors) {
      const lines = index.get(anchor.path);
      if (!lines) continue;
      if (anchor.line === undefined) valid.push({ path: anchor.path });
      else if (anchor.line > 0 && lines.has(anchor.line)) valid.push({ path: anchor.path, line: anchor.line });
    }
    if (finding.anchors.length > 0 && valid.length === 0) {
      dropped++;
      continue;
    }
    // The topic the model tagged it with, as the check it counts toward when the reviewer reacts to it.
    const checkId = finding.topic && finding.topic !== "other" ? MODEL_TOPICS[finding.topic] : undefined;
    findings.push({
      title: finding.title,
      ...(checkId ? { checkId } : {}),
      detail: finding.detail,
      severity: finding.severity,
      anchors: valid,
    });
  }
  return { findings, dropped };
}
