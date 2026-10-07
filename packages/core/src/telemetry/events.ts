import type { Briefing, RankedQueue, RepoStats, ReviewSignalEvent, TelemetryProperties } from "@alden/schema";
import { signalCounts } from "../feedback/log.js";
import { languageOf } from "../graph/parser.js";
import { repoHash } from "./telemetry.js";

/** A briefing as telemetry: sizes, counts and outcomes, never what the change says or where it is. */
export function reviewEvent(
  briefing: Briefing,
  options: { durationMs: number; repo?: string | undefined; graph: boolean },
): TelemetryProperties<"review_completed"> {
  const languages = [
    ...new Set(
      briefing.files.flatMap((f) => {
        const language = languageOf(f.path);
        return language === "tsx" ? ["typescript"] : language ? [language] : [];
      }),
    ),
  ].sort();
  const callers = briefing.checks.find((c) => c.id === "callers.outside");
  const llm = briefing.llm;
  return {
    target: briefing.target.kind,
    repo_hash: options.repo ? repoHash(options.repo) : null,
    files: briefing.summary.files,
    lines: briefing.summary.reviewableAdditions + briefing.summary.reviewableDeletions,
    languages,
    graph: options.graph,
    callers: callers?.evidence.length ?? 0,
    checks_flagged: briefing.checks.filter((c) => c.status === "flagged").length,
    places: briefing.needsYourEyes.length,
    hidden_by_feedback: briefing.learning?.hidden.length ?? 0,
    notes_used: briefing.learning?.memory ?? 0,
    llm_status: llm?.status ?? "none",
    model: llm?.status === "ok" ? (llm.model ?? null) : null,
    usd: llm?.usd === undefined ? null : Math.round(llm.usd * 10_000) / 10_000,
    duration_ms: Math.round(options.durationMs),
  };
}

export function queueEvent(queue: RankedQueue): TelemetryProperties<"queue_ranked"> {
  const rows = [...queue.needsYou, ...queue.fastTrack];
  return {
    needs_you: queue.needsYou.length,
    fast_track: queue.fastTrack.length,
    dismissed: queue.dismissed?.length ?? 0,
    repos: new Set(rows.map((r) => r.pr.repo.toLowerCase())).size,
    moved_by_learning: rows.filter((r) => (r.score.learned ?? 0) !== 0).length,
  };
}

/** What a review (or what its author did afterwards) taught Alden, as counts by kind: never where, or on what. */
export function signalsEvent(
  signals: Pick<ReviewSignalEvent, "signal">[],
  source: ReviewSignalEvent["source"],
): TelemetryProperties<"review_signals"> {
  return { source, ...signalCounts(signals) };
}

const rounded = (h: number | null | undefined) => (h === null || h === undefined ? null : Math.round(h * 10) / 10);

/** Review speed before and after Alden, as medians only: the numbers a "faster reviews" claim rests on. */
export function statsEvent(stats: RepoStats): TelemetryProperties<"stats_viewed"> {
  return {
    repo_hash: repoHash(stats.repo),
    prs: stats.prs,
    split: stats.split !== null,
    first_review_before_h: rounded(stats.timeToFirstReview.before?.medianHours),
    first_review_after_h: rounded(stats.timeToFirstReview.after?.medianHours),
    cycle_before_h: rounded(stats.cycleTime.before?.medianHours),
    cycle_after_h: rounded(stats.cycleTime.after?.medianHours),
  };
}
