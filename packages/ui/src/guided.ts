import type {
  Anchor,
  Briefing,
  LlmFinding,
  LookHere,
  PrDiff,
  PrDiffFile,
  PrDiffHunk,
  PrDiffLine,
  RelatedFile,
  Severity,
} from "@alden/schema";

/** A PR's diff as `GET /api/diff` returns it (from @alden/schema). */
export type { PrDiff, PrDiffFile, PrDiffHunk, PrDiffLine };

/**
 * A place to comment on: a line on the new side (RIGHT) or the old one (LEFT), as GitHub's review comments take, or
 * without `line` a whole file (which goes in the review body as a linked note).
 */
export interface CommentPlace {
  path: string;
  line?: number | undefined;
  side: "RIGHT" | "LEFT";
}

/** One step of a guided review: one of Alden's places, or (after them) a model finding with a place in the code. */
export interface GuidedStep {
  key: string;
  kind: "place" | "finding";
  title: string;
  /** Why it's a step: the place's reason, or the finding's detail. */
  reason: string;
  anchor?: Anchor;
  checkId?: string;
  severity?: Severity;
  source: "check" | "llm";
  learned?: string;
  related: RelatedFile[];
  /** The place itself, or the finding, for feedback. */
  item: { eyes: LookHere } | { finding: LlmFinding };
}

const anchorKey = (a: Anchor | undefined) => (a ? `${a.path}:${a.line ?? ""}` : "");

/**
 * The steps, in Alden's order: every place that needs your eyes, then the model's other findings that point at code,
 * most severe first, as optional extras. A finding already shown as a place isn't repeated.
 */
export function guidedSteps(briefing: Briefing): { steps: GuidedStep[]; core: number } {
  const steps: GuidedStep[] = briefing.needsYourEyes.map((item, i) => {
    const severity = briefing.checks.find((c) => c.id === item.checkId)?.severity;
    return {
      key: `eye:${i}:${item.title}:${anchorKey(item.anchor)}`,
      kind: "place",
      title: item.title,
      reason: item.reason,
      ...(item.anchor ? { anchor: item.anchor } : {}),
      ...(item.checkId ? { checkId: item.checkId } : {}),
      ...(severity ? { severity } : {}),
      source: item.source ?? "check",
      ...(item.learned ? { learned: item.learned } : {}),
      related: item.related ?? [],
      item: { eyes: item },
    };
  });
  const llm = briefing.llm;
  if (llm?.status === "ok") {
    const picked = new Set(briefing.needsYourEyes.flatMap((i) => (i.anchor ? [anchorKey(i.anchor)] : [])));
    const shownTitles = new Set(briefing.needsYourEyes.filter((i) => i.source === "llm").map((i) => i.title));
    const extras = llm.findings
      .filter(
        (f) => f.anchors.length > 0 && !shownTitles.has(f.title) && !f.anchors.some((a) => picked.has(anchorKey(a))),
      )
      .sort((a, b) => RANK[b.severity] - RANK[a.severity]);
    for (const finding of extras) {
      steps.push({
        key: `finding:${finding.title}:${finding.anchors.map(anchorKey).join()}`,
        kind: "finding",
        title: finding.title,
        reason: finding.detail,
        ...(finding.anchors[0] ? { anchor: finding.anchors[0] } : {}),
        ...(finding.checkId ? { checkId: finding.checkId } : {}),
        severity: finding.severity,
        source: "llm",
        related: [],
        item: { finding },
      });
    }
  }
  return { steps, core: briefing.needsYourEyes.length };
}

const RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/** The lines of one hunk around a line of the new file (or the start of the file's first hunk, without a line). */
export interface Excerpt {
  lines: PrDiffLine[];
  /** The line asked for, when it's in the diff. */
  focus?: number;
}

/**
 * Up to `radius` lines either side of `line` (a new-file line) from the hunk that holds it. Without a line, the start
 * of the first hunk. Undefined when the file isn't in the diff or the line is outside every hunk.
 */
export function excerptAround(file: PrDiffFile | undefined, line?: number, radius = 6): Excerpt | undefined {
  if (!file) return undefined;
  if (line === undefined) {
    const first = file.hunks[0];
    return first ? { lines: first.lines.slice(0, radius * 2 + 1) } : undefined;
  }
  for (const hunk of file.hunks) {
    const at = hunk.lines.findIndex((l) => l.newLine === line);
    if (at === -1) continue;
    return { lines: hunk.lines.slice(Math.max(0, at - radius), at + radius + 1), focus: line };
  }
  return undefined;
}

/** A file at the PR's head commit on GitHub, at a line. */
export function blobUrl(repo: string, headSha: string, path: string, line?: number): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo}/blob/${headSha}/${encoded}${line ? `#L${line}` : ""}`;
}

/** What each kind of related file is, in a word. */
export const RELATED_LABEL: Record<RelatedFile["why"], string> = {
  caller: "caller",
  test: "test",
  importer: "imports it",
};

/** Where you are in a PR's guided review, kept while the app is open so leaving the PR and coming back resumes. */
const progress = new Map<string, { active: boolean; step: number }>();

export const guidedKey = (briefing: Briefing) =>
  briefing.target.kind === "pr" ? `${briefing.target.repo}#${briefing.target.number}`.toLowerCase() : "local";

export function savedProgress(key: string): { active: boolean; step: number } {
  return progress.get(key) ?? { active: false, step: 0 };
}

export function saveProgress(key: string, state: { active: boolean; step: number }): void {
  progress.set(key, state);
  for (const listener of listeners) listener();
}

/** Who hears about guided review starting, moving and ending: the PR header's reading steps. */
const listeners = new Set<() => void>();

/** For `useSyncExternalStore`: calls `listener` whenever any PR's guided progress changes. */
export function subscribeProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For tests. */
export function forgetProgress(): void {
  progress.clear();
  for (const listener of listeners) listener();
}
