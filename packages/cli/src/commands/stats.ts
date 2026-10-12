import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createGitHubClient,
  JsonCache,
  loadConfig,
  openStore,
  repoFromRemote,
  repoStats,
  resolveToken,
  reviewTimeStats,
  statsEvent,
  TERMINAL_ACTIVE_CAP_MS,
  track,
  UsageLog,
} from "@alden/core";
import {
  type Distribution,
  type Metric,
  REVIEW_TIME_SMALL_SAMPLE,
  type RepoStats,
  type ReviewTimeGroup,
  type ReviewTimeStats,
} from "@alden/schema";
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

/** "40s", "12m", "1h 5m", "3d+" (at the horizon: at least that long). */
export function formatMinutes(minutes: number | null, horizonMinutes = Number.POSITIVE_INFINITY): string {
  if (minutes === null) return "–";
  if (minutes >= horizonMinutes) return `${Math.round(horizonMinutes / 1440)}d+`;
  if (minutes < 1) return `${Math.max(1, Math.round(minutes * 60))}s`;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes - hours * 60);
  if (hours < 48) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Time to review, from the review sessions on this machine: median active minutes and open-to-send, with and without
 * Alden's model, per window. No comparison: the two medians side by side, with how many reviews each rests on.
 */
export function renderReviewTime(stats: ReviewTimeStats, color: boolean): string {
  const horizon = stats.horizonHours * 60;
  const horizonDays = Math.round(stats.horizonHours / 24);
  const out = [
    `${paint("Time to review", "bold", color)} · your reviews sent with Alden, by the day you first opened the briefing`,
  ];
  if (!stats.enabled) {
    out.push(
      paint(
        "  Off: Alden isn't recording how long reviews take. `alden config set stats.reviewTime true` turns it on.",
        "dim",
        color,
      ),
    );
  }
  const longest = stats.windows.at(-1);
  const anything = stats.windows.some((w) => w.all.count > 0);
  if (!anything) {
    const waiting = longest ? longest.excluded.tooRecent : 0;
    out.push(
      paint(
        waiting > 0
          ? `  Nothing to show yet: ${plural(waiting, "review")} opened in the last ${horizonDays} days ${waiting === 1 ? "counts" : "count"} once ${waiting === 1 ? "it's" : "they're"} ${horizonDays} days old.`
          : "  No reviews timed yet: open a PR's briefing in Alden, then send your review from Alden.",
        "dim",
        color,
      ),
    );
    return `${out.join("\n")}\n`;
  }
  const cell = (g: ReviewTimeGroup) =>
    g.count === 0
      ? ["–", "–", "0"]
      : [
          formatMinutes(g.activeMedianMinutes),
          formatMinutes(g.wallMedianMinutes, horizon),
          `${g.count}${g.small ? " (few)" : ""}`,
        ];
  out.push(paint(`  ${"".padEnd(22)}${"Active".padEnd(12)}${"Open to send".padEnd(16)}Reviews`, "dim", color));
  for (const w of stats.windows) {
    out.push(`  Last ${w.days} days`);
    for (const [label, g] of [
      ["With the model", w.withModel],
      ["Without", w.withoutModel],
    ] as const) {
      const [active, wall, count] = cell(g);
      out.push(`    ${label.padEnd(20)}${(active as string).padEnd(12)}${(wall as string).padEnd(16)}${count}`);
    }
  }
  const notes: string[] = [];
  notes.push("Medians. Active is time on the PR in Alden; open to send is from first opening its briefing to sending.");
  if (
    stats.windows.some(
      (w) => (w.withModel.count > 0 && w.withModel.small) || (w.withoutModel.count > 0 && w.withoutModel.small),
    )
  ) {
    notes.push(
      `(few): under ${REVIEW_TIME_SMALL_SAMPLE} reviews, too few to read much into; the medians can swing with one review.`,
    );
  }
  if (longest) {
    const left = [
      longest.excluded.tooRecent > 0 &&
        `${longest.excluded.tooRecent} opened in the last ${horizonDays} days (counted once they're ${horizonDays} days old, so slow reviews aren't left out)`,
      longest.excluded.notSent > 0 && `${longest.excluded.notSent} opened and never sent from Alden`,
    ].filter(Boolean);
    if (left.length > 0) notes.push(`Not counted: ${left.join(", ")}.`);
    if (longest.all.estimated > 0) {
      notes.push(
        `${plural(longest.all.estimated, "review")}' active time is the terminal's estimate: briefing to send, capped at ${TERMINAL_ACTIVE_CAP_MS / 60_000} min.`,
      );
    }
    notes.push(`Open to send is capped at ${horizonDays} days (${horizonDays}d+).`);
  }
  out.push("", ...notes.map((n) => paint(`  ${n}`, "dim", color)));
  return `${out.join("\n")}\n`;
}

/** Time to review from this machine's review sessions: no GitHub, no sign-in. */
export async function loadReviewTime(): Promise<ReviewTimeStats> {
  const config = await loadConfig();
  return reviewTimeStats(openStore(), { enabled: config.stats.reviewTime });
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
    const stats = await repoStats(createGitHubClient(resolved.token), repo, {
      days: options.days,
      horizonHours: options.horizonDays * 24,
      ...(options.since ? { since: options.since } : {}),
      ...(firstUse ? { firstUse } : {}),
      cache: new JsonCache(),
      refresh: options.refresh,
    });
    await track("stats_viewed", statsEvent(stats));
    return stats;
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
  reviewTime?: boolean;
}

export function registerStatsCommand(program: Command): void {
  program
    .command("stats")
    .description(
      "Show a repo's time to first review and review cycle time, before and after Alden, and your own time to review.",
    )
    .option("--repo <owner/name>", "the repo (default: the one this clone's origin points at)")
    .option("--days <n>", "look at PRs opened in the last n days", "90")
    .option("--since <date>", "compare before and after this date (YYYY-MM-DD), instead of your first use of Alden")
    .option("--horizon <days>", "judge each wait over this many days", "14")
    .option("--refresh", "ignore the hour-long cache")
    .option("--json", "print the stats as JSON (see packages/schema/json)")
    .option("--review-time", "only your time to review, from this machine (no GitHub)")
    .action(async (options: StatsOptions) => {
      if (options.reviewTime) {
        const timed = await loadReviewTime();
        if (options.json) console.log(JSON.stringify(timed, null, 2));
        else process.stdout.write(renderReviewTime(timed, shouldColor(process.stdout)));
        return;
      }
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
      const color = shouldColor(process.stdout);
      process.stdout.write(renderStats(stats, color));
      // Your own time to review, from this machine: across repos, so it's after the repo's numbers.
      try {
        process.stdout.write(`\n${renderReviewTime(await loadReviewTime(), color)}`);
      } catch {
        // the local database can't be read: the repo's stats stand alone
      }
    });
}
