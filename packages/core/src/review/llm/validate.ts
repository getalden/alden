import type { Anchor, LlmFinding, LlmFindingDraft } from "@alden/schema";
import type { DiffFile } from "../../diff/parse.js";
import { MODEL_TOPICS } from "../../learn/learn.js";
import { checkSuggestion, placeOnDiff } from "../drafts.js";
import { findInjection } from "../injection.js";
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

/** The longest drafted comment Alden keeps: a draft is a few sentences, so anything longer went wrong. */
export const MAX_DRAFT_CHARS = 2_000;
/** The most lines a drafted suggestion may have: "a small, certain replacement" of one line. */
export const MAX_SUGGESTION_LINES = 10;

/**
 * The model's drafted comment for a finding, when Alden can offer it as one: the finding is medium or high, its first
 * line anchor is an added line of a file the model saw, the comment says something in plain words (not "as an AI…",
 * nothing aimed at AI reviewers) and fits, and any suggestion is a real change GitHub can apply to that line (see
 * `checkSuggestion`) with no redaction placeholder in it. Undefined otherwise: the finding stays, without a draft.
 */
export function checkDraft(
  draft: { body: string; suggestion?: string | undefined } | undefined,
  finding: { severity: LlmFinding["severity"]; anchors: Anchor[] },
  shownFiles: DiffFile[],
): LlmFindingDraft | undefined {
  if (!draft || (finding.severity !== "medium" && finding.severity !== "high")) return undefined;
  const anchor = finding.anchors.find((a) => a.line !== undefined);
  if (!anchor || anchor.line === undefined) return undefined;
  const file = shownFiles.find((f) => f.path === anchor.path);
  const added = file?.hunks.some((h) => h.lines.some((l) => l.kind === "add" && l.newLine === anchor.line));
  if (!file || !added) return undefined;
  const body = draft.body.trim();
  if (!body || body.length > MAX_DRAFT_CHARS || /\bas an ai\b/i.test(body) || findInjection(body)) return undefined;
  if (draft.suggestion === undefined) return { body };
  const suggestion = draft.suggestion.replace(/\r?\n$/, "");
  const place = placeOnDiff(shownFiles, anchor.path, anchor.line, "RIGHT");
  if ("problem" in place) return undefined;
  try {
    checkSuggestion(suggestion, place);
  } catch {
    return undefined;
  }
  const same = suggestion === (place.lines ?? [place.anchor.text]).join("\n");
  if (same || suggestion.split("\n").length > MAX_SUGGESTION_LINES || /\[redacted\b/i.test(suggestion)) {
    return undefined;
  }
  return { body, suggestion };
}

/**
 * Keeps only what can be checked against the diff. Each anchor must name a file the model was shown, and a line in
 * that file's visible hunks when it gives one. A finding whose anchors all fail is dropped as invented; a finding
 * with no anchors at all (e.g. "the title promises X") is kept as a general note.
 */
/**
 * The note a finding says it came from, when the model named one of the ids its prompt gave the reviewer's notes
 * ("N1", or "[N1]"). Anything else is dropped: the id can only point at a note Alden put in the prompt, never at text
 * from the PR.
 */
export function noteOf(
  fromNote: string | undefined,
  notes: ReadonlyMap<string, { id: string; text: string }>,
): { id: string; text: string } | undefined {
  const short = /^\[?\s*(N\d+)\s*\]?$/i.exec(fromNote?.trim() ?? "")?.[1]?.toUpperCase();
  const note = short ? notes.get(short) : undefined;
  return note ? { id: note.id, text: note.text } : undefined;
}

export function validateFindings(
  output: LlmOutput,
  shownFiles: DiffFile[],
  notes: ReadonlyMap<string, { id: string; text: string }> = new Map(),
  /** Whether drafts were asked for: without it, a draft the model sent anyway is ignored. */
  options: { drafts?: boolean } = {},
): ValidatedFindings {
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
    const fromNote = noteOf(finding.fromNote, notes);
    // The topic the model tagged it with, as the check it counts toward when the reviewer reacts to it. A finding
    // from one of your notes counts toward the note instead, so it's tied to no check.
    const checkId = !fromNote && finding.topic && finding.topic !== "other" ? MODEL_TOPICS[finding.topic] : undefined;
    const draft = options.drafts
      ? checkDraft(finding.draft, { severity: finding.severity, anchors: valid }, shownFiles)
      : undefined;
    findings.push({
      title: finding.title,
      ...(checkId ? { checkId } : {}),
      detail: finding.detail,
      severity: finding.severity,
      anchors: valid,
      ...(fromNote ? { fromNote } : {}),
      ...(draft ? { draft } : {}),
    });
  }
  return { findings, dropped };
}
