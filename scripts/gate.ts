/**
 * Phase 1's gate, from what design partners send each week: `pnpm gate <folder of exports> [--md]`.
 *
 * Each file in the folder is one team's `alden feedback --export` (name it after the team: acme.json). The gate is
 * "10 teams use Alden weekly, and reviewers find most 'needs your eyes' flags useful". A team counts as active when it
 * gave feedback in the 7 days before its export. The agree rate pools every team's verdicts on "needs your eyes",
 * from each export's own summary (made before redaction, so it's exact). With POSTHOG_PERSONAL_API_KEY set, it also
 * reads weekly active installs and the useful rate from usage stats, for teams that opted in. `--md` prints a table
 * for the Partners tab.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { FeedbackEvent, FeedbackSummary } from "../packages/schema/src/index.js";

const TEAMS_NEEDED = 10;
const WEEK_MS = 7 * 24 * 3_600_000;

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const markdown = args.includes("--md");
if (!dir) throw new Error("Usage: pnpm gate <folder of alden feedback exports> [--md]");

interface Export {
  exportedAt: string;
  redacted: boolean;
  summary: FeedbackSummary;
  events: FeedbackEvent[];
}

interface Team {
  team: string;
  exportedAt: string;
  active: boolean;
  lastFeedback: string | null;
  eyesAgree: number;
  eyesNotNeeded: number;
  missed: number;
  briefings: number;
  feedbackThisWeek: number;
}

const teams: Team[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((file) => {
    const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as Export;
    const exportedAt = Date.parse(data.exportedAt);
    const times = data.events.map((e) => Date.parse(e.at)).filter(Number.isFinite);
    const thisWeek = times.filter((t) => t > exportedAt - WEEK_MS && t <= exportedAt).length;
    const last = times.length ? new Date(Math.max(...times)).toISOString() : null;
    return {
      team: basename(file, ".json"),
      exportedAt: data.exportedAt,
      active: thisWeek > 0,
      lastFeedback: last,
      eyesAgree: data.summary.eyes.agree,
      eyesNotNeeded: data.summary.eyes.notNeeded,
      missed: data.summary.missed,
      briefings: data.summary.briefings,
      feedbackThisWeek: thisWeek,
    };
  });

const active = teams.filter((t) => t.active).length;
const agree = teams.reduce((n, t) => n + t.eyesAgree, 0);
const notNeeded = teams.reduce((n, t) => n + t.eyesNotNeeded, 0);
const rate = agree + notNeeded > 0 ? agree / (agree + notNeeded) : null;
const pct = (r: number | null) => (r === null ? "—" : `${Math.round(r * 100)}%`);
const teamRate = (t: Team) =>
  t.eyesAgree + t.eyesNotNeeded > 0 ? t.eyesAgree / (t.eyesAgree + t.eyesNotNeeded) : null;

/** Weekly active installs and the useful rate on "needs your eyes", from opted-in usage stats. */
async function usageStats(): Promise<{ installs: number; useful: number | null } | undefined> {
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  if (!key) return undefined;
  const host = process.env.POSTHOG_HOST ?? "https://eu.posthog.com";
  const project = process.env.POSTHOG_PROJECT_ID ?? "@current";
  const query = `SELECT
  count(DISTINCT distinct_id),
  countIf(event = 'feedback_given' AND properties.placement = 'eyes' AND properties.verdict = 'agree'),
  countIf(event = 'feedback_given' AND properties.placement = 'eyes' AND properties.verdict = 'not_needed')
FROM events WHERE timestamp > now() - INTERVAL 7 DAY`;
  const response = await fetch(`${host}/api/projects/${project}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
  });
  if (!response.ok) throw new Error(`PostHog: ${response.status} ${await response.text()}`);
  const [[installs = 0, a = 0, b = 0] = []] = ((await response.json()) as { results: number[][] }).results;
  return { installs, useful: a + b > 0 ? a / (a + b) : null };
}

const stats = await usageStats();
const teamsMet = active >= TEAMS_NEEDED;
const rateMet = rate !== null && rate > 0.5;

if (markdown) {
  console.log("| Team | Active this week | Agree rate (eyes) | Verdicts | Misses | Briefings | Export |");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  for (const t of teams) {
    console.log(
      `| ${t.team} | ${t.active ? `yes (${t.feedbackThisWeek})` : "no"} | ${pct(teamRate(t))} | ${t.eyesAgree + t.eyesNotNeeded} | ${t.missed} | ${t.briefings} | ${t.exportedAt.slice(0, 10)} |`,
    );
  }
  console.log(`| **All** | **${active} of ${TEAMS_NEEDED}** | **${pct(rate)}** | ${agree + notNeeded} | | | |`);
} else {
  console.log(`Gate check from ${teams.length} team export${teams.length === 1 ? "" : "s"} in ${dir}\n`);
  for (const t of teams) {
    console.log(
      `${t.active ? "●" : "○"} ${t.team.padEnd(18)} agree ${pct(teamRate(t)).padStart(4)} of ${String(t.eyesAgree + t.eyesNotNeeded).padStart(3)} · ${t.missed} missed · ${t.briefings} briefings · last feedback ${t.lastFeedback?.slice(0, 10) ?? "never"}`,
    );
  }
  console.log("");
}
console.log(
  `${teamsMet ? "✓" : "✗"} Teams using Alden weekly: ${active} of the ${TEAMS_NEEDED} needed (gave feedback in the week before their export)`,
);
console.log(
  `${rateMet ? "✓" : "✗"} Agree rate on "needs your eyes": ${pct(rate)} of ${agree + notNeeded} verdicts (needs more than half)`,
);
if (stats) {
  console.log(
    `  Usage stats, last 7 days: ${stats.installs} active install${stats.installs === 1 ? "" : "s"}, useful rate ${pct(stats.useful)} (opted-in installs only)`,
  );
} else console.log("  Set POSTHOG_PERSONAL_API_KEY to add weekly active installs from usage stats.");
console.log(teamsMet && rateMet ? "\nThe gate is met." : "\nThe gate isn't met yet.");
