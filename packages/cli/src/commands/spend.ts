import { loadConfig, localDay, type SpendEntry, SpendLedger } from "@alden/core";
import type { Command } from "commander";
import { paint, shouldColor } from "../render/style.js";

const usd = (n: number) => `$${n.toFixed(2)}`;

interface DaySummary {
  day: string;
  calls: number;
  usd: number;
  unpriced: number;
}

export interface SpendReport {
  today: string;
  spentToday: number;
  dailyUsd: number;
  perReviewUsd: number;
  byModel: { model: string; calls: number; usd: number | null }[];
  lastDays: DaySummary[];
}

function summarise(day: string, entries: SpendEntry[]): DaySummary {
  return {
    day,
    calls: entries.length,
    usd: entries.reduce((sum, e) => sum + (e.usd ?? 0), 0),
    unpriced: entries.filter((e) => e.usd === undefined).length,
  };
}

export async function spendReport(
  ledger: SpendLedger,
  limits: { dailyUsd: number; perReviewUsd: number },
): Promise<SpendReport> {
  const today = localDay();
  const todays = await ledger.entries(today);
  const models = new Map<string, { calls: number; usd: number | null }>();
  for (const entry of todays) {
    const row = models.get(entry.model) ?? { calls: 0, usd: 0 };
    row.calls++;
    row.usd = entry.usd === undefined || row.usd === null ? null : row.usd + entry.usd;
    models.set(entry.model, row);
  }
  const days = (await ledger.days()).slice(0, 7);
  return {
    today,
    spentToday: summarise(today, todays).usd,
    dailyUsd: limits.dailyUsd,
    perReviewUsd: limits.perReviewUsd,
    byModel: [...models].map(([model, row]) => ({ model, ...row })).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0)),
    lastDays: await Promise.all(days.map(async (day) => summarise(day, await ledger.entries(day)))),
  };
}

export function renderSpend(report: SpendReport, color: boolean): string {
  const left = Math.max(0, report.dailyUsd - report.spentToday);
  const out = [
    `${paint(`Today (${report.today})`, "bold", color)}: ${usd(report.spentToday)} of your ${usd(report.dailyUsd)} daily cap · ${usd(left)} left`,
    paint(`Each review is capped at ${usd(report.perReviewUsd)}. Prices are Anthropic list prices.`, "dim", color),
  ];
  if (report.byModel.length === 0) out.push("  No model calls today.");
  for (const row of report.byModel) {
    const cost = row.usd === null ? "price unknown" : usd(row.usd);
    out.push(`  ${row.model.padEnd(22)} ${`${row.calls} call${row.calls === 1 ? "" : "s"}`.padEnd(10)} ${cost}`);
  }
  if (report.lastDays.length > 0) {
    out.push("", paint("Last 7 days with spending", "bold", color));
    for (const day of report.lastDays) {
      const unpriced = day.unpriced > 0 ? paint(` (+${day.unpriced} unpriced)`, "dim", color) : "";
      out.push(`  ${day.day}  ${usd(day.usd).padStart(7)}  ${day.calls} call${day.calls === 1 ? "" : "s"}${unpriced}`);
    }
  }
  return `${out.join("\n")}\n`;
}

export function registerSpendCommand(program: Command): void {
  program
    .command("spend")
    .description("Show what Alden has spent on models today and recently, against your caps.")
    .option("--json", "print the report as JSON")
    .action(async (options: { json?: boolean }) => {
      const config = await loadConfig();
      const report = await spendReport(new SpendLedger(), config.budget);
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      process.stdout.write(renderSpend(report, shouldColor(process.stdout)));
    });
}
