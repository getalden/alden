import { writeFile } from "node:fs/promises";
import { checkProgress, FeedbackLog, type Learning, loadLearning, openStore } from "@alden/core";
import type { FeedbackSummary } from "@alden/schema";
import type { Command } from "commander";
import { paint, shouldColor } from "../render/style.js";

const percent = (rate: number | null) => (rate === null ? "no verdicts yet" : `${Math.round(rate * 100)}%`);

/**
 * Where each check lesson stands in a repo, from the side your verdicts lean to: "2 of 3: one more not useful on API
 * change flags … and Alden will quieten them", or what it already does.
 */
export function learningLines(learning: Learning): string[] {
  return [...learning.checkTallies]
    .filter(([, t]) => t.agree + t.notNeeded > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([topic, t]) => {
      const lesson = learning.checks.get(topic);
      const verdict = (lesson ? lesson.direction === "up" : t.agree > t.notNeeded) ? "agree" : "not_needed";
      // A topic's own id is a check id, except "api", which signature flags stand for.
      const checkId = topic === "api" ? "signatures.changed" : topic;
      const line = checkProgress(learning, { source: "check", checkId }, verdict);
      return line && !line.startsWith("Saved.") ? [line] : [];
    });
}

/**
 * What your sent reviews said without a click: "From 4 reviews you sent: 3 comments, 1 suggestion near flags, 2
 * approved past without a word, 1 comment where Alden flagged nothing". Nothing when there are none.
 */
function reviewLine(summary: FeedbackSummary): string[] {
  const s = summary.reviewSignals;
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const near = [
    s.request_changes > 0 && plural(s.request_changes, "comment requesting changes", "comments requesting changes"),
    s.suggestion > 0 && plural(s.suggestion, "suggestion"),
    s.comment > 0 && plural(s.comment, "comment"),
  ].filter(Boolean);
  const parts = [
    near.length > 0 && `${near.join(", ")} near flags`,
    s.silent_pass > 0 && `${plural(s.silent_pass, "flag")} you saw and approved past`,
    s.miss > 0 && `${plural(s.miss, "comment")} where Alden flagged nothing`,
    s.applied + s.resolved > 0 &&
      `${plural(s.applied, "suggestion")} applied and ${plural(s.resolved, "comment")} resolved by authors`,
  ].filter(Boolean);
  if (summary.reviews === 0 && parts.length === 0) return [];
  return [`From ${plural(summary.reviews, "review")} you sent: ${parts.join("; ") || "nothing near a flag yet"}`];
}

export function renderFeedback(
  summary: FeedbackSummary,
  color: boolean,
  progress: { repo: string; lines: string[] }[] = [],
): string {
  const signals = summary.reviewSignals;
  if (summary.briefings === 0 && summary.reviews === 0) {
    return "No feedback yet. Mark flags useful or not useful in `alden ui` (or through `alden mcp`), report what Alden missed, or send a review from Alden.\n";
  }
  const eyes = summary.eyes.agree + summary.eyes.notNeeded;
  const out = [
    `${paint('Useful rate on "needs your eyes"', "bold", color)}: ${percent(summary.eyesAgreeRate)} (${summary.eyes.agree} of ${eyes})`,
    `Model findings: ${summary.modelFindings.agree} useful, ${summary.modelFindings.notNeeded} not useful`,
    `Missed: ${summary.missed}${signals.miss > 0 ? ` (and ${signals.miss} from comments in your reviews)` : ""} · Briefings with feedback: ${summary.briefings}${summary.since ? ` · since ${summary.since.slice(0, 10)}` : ""}`,
    ...reviewLine(summary),
    "",
    paint("By check", "bold", color),
  ];
  const rows = Object.entries(summary.byCheck).sort(([, a], [, b]) => b.agree + b.notNeeded - (a.agree + a.notNeeded));
  const width = Math.max(...rows.map(([id]) => id.length), 5);
  for (const [id, c] of rows) {
    const rate = c.agree + c.notNeeded === 0 ? null : c.agree / (c.agree + c.notNeeded);
    out.push(
      `  ${id.padEnd(width)}  ${String(c.agree).padStart(3)} useful  ${String(c.notNeeded).padStart(3)} not useful  ${percent(rate)}`,
    );
  }
  const learning = progress.filter((p) => p.lines.length > 0);
  if (learning.length > 0) {
    out.push("", paint("What Alden is learning", "bold", color));
    for (const { repo, lines } of learning) {
      out.push(`  ${repo}`, ...lines.map((l) => `    ${l}`));
    }
    out.push("  Lessons need three alike, at least three to one. `alden memory` lists what's learned.");
  }
  return `${out.join("\n")}\n`;
}

interface FeedbackOptions {
  json?: boolean;
  export?: string;
  full?: boolean;
}

export function registerFeedbackCommand(program: Command): void {
  program
    .command("feedback")
    .description("Show how often you found Alden's flags useful, and what it missed.")
    .option("--json", "print the summary as JSON")
    .option("--export <file>", "write your feedback to a file you can share, with repos, paths and notes removed")
    .option("--full", "with --export: keep repo names, titles, paths and notes")
    .action(async (options: FeedbackOptions) => {
      const log = new FeedbackLog();
      if (options.export) {
        const events = await log.events();
        const shared = options.full ? events : await log.redacted();
        const signals = options.full ? log.signals() : log.redactedSignals();
        const summary = await log.summary();
        await writeFile(
          options.export,
          `${JSON.stringify({ exportedAt: new Date().toISOString(), redacted: !options.full, summary, events: shared, signals }, null, 2)}\n`,
          "utf8",
        );
        console.log(
          `Wrote ${events.length} feedback events${signals.length > 0 ? ` and ${signals.length} review signals` : ""} to ${options.export}${options.full ? "." : ", with repos, titles, paths and notes removed."}`,
        );
        return;
      }
      const summary = await log.summary();
      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }
      process.stdout.write(renderFeedback(summary, shouldColor(process.stdout), await progressByRepo(log)));
    });
}

/** Where lessons stand in each repo you've given feedback in. Never stops the command. */
async function progressByRepo(log: FeedbackLog): Promise<{ repo: string; lines: string[] }[]> {
  try {
    const repos = [
      ...new Set((await log.events()).flatMap((e) => (e.target.repo ? [e.target.repo.toLowerCase()] : []))),
    ].sort();
    const store = openStore();
    const out = [];
    for (const repo of repos) out.push({ repo, lines: learningLines(await loadLearning(store, repo)) });
    return out;
  } catch {
    return [];
  }
}
