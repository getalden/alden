import { writeFile } from "node:fs/promises";
import { FeedbackLog, redactFeedback } from "@alden/core";
import type { FeedbackSummary } from "@alden/schema";
import type { Command } from "commander";
import { paint, shouldColor } from "../render/style.js";

const percent = (rate: number | null) => (rate === null ? "no verdicts yet" : `${Math.round(rate * 100)}%`);

export function renderFeedback(summary: FeedbackSummary, color: boolean): string {
  if (summary.briefings === 0) {
    return "No feedback yet. Mark flags as agreed or not needed in `alden ui`, and report what Alden missed.\n";
  }
  const eyes = summary.eyes.agree + summary.eyes.notNeeded;
  const out = [
    `${paint('Agree rate on "needs your eyes"', "bold", color)}: ${percent(summary.eyesAgreeRate)} (${summary.eyes.agree} of ${eyes})`,
    `Model findings: ${summary.modelFindings.agree} agreed, ${summary.modelFindings.notNeeded} not needed`,
    `Missed: ${summary.missed} · Briefings with feedback: ${summary.briefings}${summary.since ? ` · since ${summary.since.slice(0, 10)}` : ""}`,
    "",
    paint("By check", "bold", color),
  ];
  const rows = Object.entries(summary.byCheck).sort(([, a], [, b]) => b.agree + b.notNeeded - (a.agree + a.notNeeded));
  const width = Math.max(...rows.map(([id]) => id.length), 5);
  for (const [id, c] of rows) {
    const rate = c.agree + c.notNeeded === 0 ? null : c.agree / (c.agree + c.notNeeded);
    out.push(
      `  ${id.padEnd(width)}  ${String(c.agree).padStart(3)} agreed  ${String(c.notNeeded).padStart(3)} not needed  ${percent(rate)}`,
    );
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
    .description("Show how often you agreed with Alden's flags, and what it missed.")
    .option("--json", "print the summary as JSON")
    .option("--export <file>", "write your feedback to a file you can share, with repos, paths and notes removed")
    .option("--full", "with --export: keep repo names, titles, paths and notes")
    .action(async (options: FeedbackOptions) => {
      const log = new FeedbackLog();
      if (options.export) {
        const events = await log.events();
        const shared = options.full ? events : redactFeedback(events);
        const summary = await log.summary();
        await writeFile(
          options.export,
          `${JSON.stringify({ exportedAt: new Date().toISOString(), redacted: !options.full, summary, events: shared }, null, 2)}\n`,
          "utf8",
        );
        console.log(
          `Wrote ${events.length} feedback events to ${options.export}${options.full ? "." : ", with repos, titles, paths and notes removed."}`,
        );
        return;
      }
      const summary = await log.summary();
      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }
      process.stdout.write(renderFeedback(summary, shouldColor(process.stdout)));
    });
}
