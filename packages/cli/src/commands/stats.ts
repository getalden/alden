import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createGitHubClient, JsonCache, repoFromRemote, repoStats, resolveToken, UsageLog } from "@alden/core";
import type { Distribution, Metric, RepoStats } from "@alden/schema";
import type { Command } from "commander";
import { describeGitHubError } from "../github-errors.js";
import { paint, shouldColor } from "../render/style.js";

/** "45m", "9h", "1d 16h", "14d+" (at the horizon: at least that long). */
export function formatHours(hours: number | null, horizon: number): string {
  if (hours === null) return "–";
  if (hours >= horizon) return `${Math.round(horizon / 24)}d+`;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours - days * 24);
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

/** How the median moved: "38% faster", "2.1× slower", "no change". Null when either side has no data. */
export function change(before: Distribution | null, after: Distribution | null): string | null {
  const b = before?.medianHours;
  const a = after?.medianHours;
  if (b === null || b === undefined || a === null || a === undefined || b === 0) return null;
  if (Math.abs(a - b) / b < 0.05) return "no change";
  if (a < b) return `${Math.round((1 - a / b) * 100)}% faster`;
  return a / b >= 2 ? `${(a / b).toFixed(1)}× slower` : `${Math.round((a / b - 1) * 100)}% slower`;
}

const BARS = "▁▂▃▄▅▆▇█";

/** Weekly medians as a one-line chart, scaled to the horizon; a gap for weeks with nothing to measure. */
export function sparkline(values: (number | null)[], horizon: number): string {
  return values
    .map((v) => (v === null ? " " : BARS[Math.min(BARS.length - 1, Math.floor((v / horizon) * BARS.length))]))
    .join("");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "1 Sep", in UTC, the same everywhere (locale data varies between Node builds). */
const shortDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

export function renderStats(stats: RepoStats, color: boolean): string {
  const h = stats.horizonHours;
  const days = Math.round((Date.parse(stats.window.to) - Date.parse(stats.window.from)) / 86_400_000);
  const dist = (d: Distribution | null) =>
    d && d.count > 0
      ? `${formatHours(d.medianHours, h)} median · ${formatHours(d.p90Hours, h)} p90 (${d.count})`
      : "no PRs";
  const out = [
    `${paint(stats.repo, "bold", color)} · PRs opened in the last ${days} days · waits judged over ${Math.round(h / 24)} days`,
    "",
  ];

  const row = (label: string, metric: Metric) => {
    if (!stats.split || (stats.timeToFirstReview.after?.count ?? 0) === 0)
      return `  ${label.padEnd(22)}${dist(metric.all)}`;
    const moved = change(metric.before, metric.after);
    return `  ${label.padEnd(22)}${dist(metric.before).padEnd(34)}${dist(metric.after).padEnd(34)}${moved ? paint(moved, "bold", color) : ""}`;
  };
  // Split, but nothing after it is old enough to judge yet: show the overall numbers and when comparing can start.
  const tooSoon = stats.split !== null && (stats.timeToFirstReview.after?.count ?? 0) === 0;
  if (stats.split && tooSoon) {
    const ready = new Date(Date.parse(stats.split.at) + h * 3_600_000).toISOString();
    out.push(row("Time to first review", stats.timeToFirstReview), row("Review cycle time", stats.cycleTime));
    out.push(
      "",
      paint(
        `  Too soon to compare: PRs ready from ${shortDate(stats.split.at)} can be judged from ${shortDate(ready)}, once they've had ${Math.round(h / 24)} days.`,
        "dim",
        color,
      ),
    );
  } else if (stats.split) {
    const since = shortDate(stats.split.at);
    const why = stats.split.source === "since" ? "--since" : "your first review with Alden here";
    out.push(
      paint(`  ${"".padEnd(22)}${`Before ${since}`.padEnd(34)}${`From ${since}`.padEnd(34)}Median`, "dim", color),
    );
    out.push(row("Time to first review", stats.timeToFirstReview), row("Review cycle time", stats.cycleTime));
    out.push("", paint(`  Split at ${since}: ${why}.`, "dim", color));
  } else {
    out.push(row("Time to first review", stats.timeToFirstReview), row("Review cycle time", stats.cycleTime));
    out.push(
      "",
      paint(
        "  No before and after yet: Alden starts the clock the first time you review a PR in this repo. Pass --since YYYY-MM-DD to compare from a date.",
        "dim",
        color,
      ),
    );
  }

  if (stats.weeks.length > 1) {
    out.push(
      "",
      `  Weekly median time to first review  ${sparkline(
        stats.weeks.map((w) => w.timeToFirstReviewMedianHours),
        h,
      )}  ${paint(`${stats.weeks[0]?.week} → ${stats.weeks.at(-1)?.week}`, "dim", color)}`,
    );
  }

  const notes = [
    stats.excluded.tooRecent > 0 && `${stats.excluded.tooRecent} too recent to judge`,
    stats.stillWaiting.review > 0 &&
      `${stats.stillWaiting.review} still waiting for a review (counted as ${Math.round(h / 24)}d+)`,
    stats.excluded.noReview > 0 && `${stats.excluded.noReview} merged or closed without a review`,
    stats.excluded.bots > 0 && `${stats.excluded.bots} by bots`,
    stats.excluded.drafts > 0 && `${stats.excluded.drafts} still drafts`,
  ].filter(Boolean);
  out.push("", paint(`  ${stats.prs} PRs opened${notes.length > 0 ? `: ${notes.join(", ")}` : ""}.`, "dim", color));
  if (stats.truncated) {
    out.push(
      paint("  GitHub's search stops at 1,000 PRs, so older ones are missing. Try a shorter --days.", "dim", color),
    );
  }
  return `${out.join("\n")}\n`;
}

/** Stats for one repo, as `alden stats` and the UI get them. Errors are worded for a person. */
export async function loadRepoStats(
  repo: string,
  options: { days: number; horizonDays: number; since?: Date; refresh: boolean },
): Promise<RepoStats> {
  const resolved = await resolveToken();
  if (!resolved) throw new Error("Not signed in. Run `alden auth login`.");
  const firstUse = await new UsageLog().firstUse(repo);
  try {
    return await repoStats(createGitHubClient(resolved.token), repo, {
      days: options.days,
      horizonHours: options.horizonDays * 24,
      ...(options.since ? { since: options.since } : {}),
      ...(firstUse ? { firstUse } : {}),
      cache: new JsonCache(),
      refresh: options.refresh,
    });
  } catch (error) {
    throw new Error(describeGitHubError(error, resolved.source));
  }
}

interface StatsOptions {
  repo?: string;
  days: string;
  since?: string;
  horizon: string;
  refresh?: boolean;
  json?: boolean;
}

export function registerStatsCommand(program: Command): void {
  program
    .command("stats")
    .description("Show a repo's time to first review and review cycle time, before and after Alden.")
    .option("--repo <owner/name>", "the repo (default: the one this clone's origin points at)")
    .option("--days <n>", "look at PRs opened in the last n days", "90")
    .option("--since <date>", "compare before and after this date (YYYY-MM-DD), instead of your first use of Alden")
    .option("--horizon <days>", "judge each wait over this many days", "14")
    .option("--refresh", "ignore the hour-long cache")
    .option("--json", "print the stats as JSON (see packages/schema/json)")
    .action(async (options: StatsOptions) => {
      const days = Number.parseInt(options.days, 10);
      const horizon = Number.parseInt(options.horizon, 10);
      if (!Number.isInteger(days) || days < 1 || days > 365)
        program.error("--days must be a whole number from 1 to 365.");
      if (!Number.isInteger(horizon) || horizon < 1 || horizon >= days) {
        program.error("--horizon must be a whole number of days, shorter than --days.");
      }
      const since = options.since ? new Date(`${options.since}T00:00:00Z`) : undefined;
      if (since && Number.isNaN(since.getTime())) program.error("--since must be a date, e.g. 2026-09-01.");

      let repo = options.repo;
      if (!repo) {
        try {
          const { stdout } = await promisify(execFile)("git", ["remote", "get-url", "origin"]);
          repo = repoFromRemote(stdout);
        } catch {
          // not in a clone
        }
      }
      if (!repo) program.error("Which repo? Run this in a clone of it, or pass --repo owner/name.");

      let stats: RepoStats;
      try {
        stats = await loadRepoStats(repo, {
          days,
          horizonDays: horizon,
          refresh: options.refresh ?? false,
          ...(since ? { since } : {}),
        });
      } catch (error) {
        program.error((error as Error).message);
      }
      if (options.json) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }
      process.stdout.write(renderStats(stats, shouldColor(process.stdout)));
    });
}
