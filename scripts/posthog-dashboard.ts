/**
 * Creates or updates the "Alden beta" dashboard in Alden's PostHog project (EU):
 * `POSTHOG_PERSONAL_API_KEY=phx_… pnpm posthog:dashboard` (add `--print` to see the insights without sending).
 *
 * The key is a personal API key with insight and dashboard write access (PostHog → Settings → Personal API keys), not
 * the public project key in the code; it stays in your environment. Re-running updates the insights in place, matched
 * by name, so this file is the dashboard's source of truth. Every event and property it reads is in
 * packages/schema/src/telemetry.ts.
 */

const HOST = process.env.POSTHOG_HOST ?? "https://eu.posthog.com";
const PROJECT = process.env.POSTHOG_PROJECT_ID ?? "@current";
const DASHBOARD = "Alden beta";
const print = process.argv.includes("--print");

type Query = Record<string, unknown>;
const event = (name: string, extra: Record<string, unknown> = {}) => ({ kind: "EventsNode", event: name, ...extra });
/** Unique installs doing anything: events are sent without person profiles, keyed by the install's random id. */
const anything = (extra: Record<string, unknown> = {}) => ({
  kind: "EventsNode",
  event: null,
  name: "All events",
  math: "dau",
  ...extra,
});
const is = (key: string, value: string | string[]) => ({
  key,
  value: Array.isArray(value) ? value : [value],
  operator: "exact",
  type: "event",
});
const trends = (series: unknown[], extra: Record<string, unknown> = {}): Query => ({
  kind: "InsightVizNode",
  source: { kind: "TrendsQuery", series, interval: "week", dateRange: { date_from: "-90d" }, ...extra },
});
const sql = (query: string): Query => ({ kind: "DataVisualizationNode", source: { kind: "HogQLQuery", query } });

/** In dashboard order. Descriptions say what each is for: the gate, the product or the launch story. */
const INSIGHTS: { name: string; description: string; query: Query }[] = [
  {
    name: "Weekly active installs",
    description: 'Installs that did anything that week. The gate\'s "teams using it weekly", as installs.',
    query: trends([anything({ custom_name: "Active installs" })]),
  },
  {
    name: "Active installs by surface",
    description: "Terminal, web UI or desktop app: where people use Alden.",
    query: trends([anything()], {
      breakdownFilter: { breakdown: "surface", breakdown_type: "event" },
      trendsFilter: { display: "ActionsBarStacked" },
    }),
  },
  {
    name: "Briefings per week",
    description: "Reviews of PRs and of local changes.",
    query: trends([event("review_completed", { math: "total" })], {
      breakdownFilter: { breakdown: "target", breakdown_type: "event" },
      trendsFilter: { display: "ActionsBarStacked" },
    }),
  },
  {
    name: "Useful rate on needs-your-eyes",
    description:
      'Useful ÷ (useful + not useful) on "needs your eyes" places, weekly. The gate\'s second half: most should be useful.',
    query: trends(
      [
        event("feedback_given", { math: "total", properties: [is("verdict", "agree"), is("placement", "eyes")] }),
        event("feedback_given", { math: "total", properties: [is("verdict", "not_needed"), is("placement", "eyes")] }),
      ],
      { trendsFilter: { formula: "A / (A + B) * 100", aggregationAxisFormat: "percentage" } },
    ),
  },
  {
    name: "Feedback by verdict",
    description: "Useful, not useful and dismiss on briefings: is anyone teaching Alden?",
    query: trends([event("feedback_given", { math: "total" })], {
      breakdownFilter: { breakdown: "verdict", breakdown_type: "event" },
      trendsFilter: { display: "ActionsBarStacked" },
    }),
  },
  {
    name: "Week-over-week retention",
    description: "Of installs active in a week, how many come back in the weeks after.",
    query: {
      kind: "InsightVizNode",
      source: {
        kind: "RetentionQuery",
        dateRange: { date_from: "-90d" },
        retentionFilter: {
          period: "Week",
          totalIntervals: 8,
          retentionType: "retention_first_time",
          targetEntity: { id: "telemetry_enabled", type: "events", name: "telemetry_enabled" },
          returningEntity: { id: "review_completed", type: "events", name: "review_completed" },
        },
      },
    },
  },
  {
    name: "First-week funnel",
    description: "Opted in → ranked a queue → got a briefing → marked a place, within 14 days.",
    query: {
      kind: "InsightVizNode",
      source: {
        kind: "FunnelsQuery",
        series: [event("telemetry_enabled"), event("queue_ranked"), event("review_completed"), event("feedback_given")],
        dateRange: { date_from: "-90d" },
        funnelsFilter: { funnelWindowInterval: 14, funnelWindowIntervalUnit: "day" },
      },
    },
  },
  {
    name: "Time to first review, before and after",
    description:
      "Median hours to first review on repos with a before and after (from alden stats), latest per repo. The launch number.",
    query: sql(`SELECT
  count() AS repos,
  round(median(before), 1) AS median_hours_before,
  round(median(after), 1) AS median_hours_after,
  round((1 - median(after) / median(before)) * 100) AS percent_faster
FROM (
  SELECT
    properties.repo_hash AS repo,
    argMax(toFloat(properties.first_review_before_h), timestamp) AS before,
    argMax(toFloat(properties.first_review_after_h), timestamp) AS after
  FROM events
  WHERE event = 'stats_viewed' AND toString(properties.split) = 'true' AND timestamp > now() - INTERVAL 90 DAY
  GROUP BY repo
)
WHERE before > 0 AND after IS NOT NULL`),
  },
  {
    name: "Beyond the diff",
    description:
      'Per briefing: callers found outside the diff, places shown, and what learning hid. The "shows what the diff doesn\'t" claim.',
    query: sql(`SELECT
  count() AS briefings,
  round(avg(toFloat(properties.callers)), 1) AS callers_per_briefing,
  round(countIf(toFloat(properties.callers) > 0) / count() * 100) AS percent_with_callers,
  round(avg(toFloat(properties.places)), 1) AS places_per_briefing,
  sum(toFloat(properties.hidden_by_feedback)) AS hidden_by_learning,
  round(countIf(properties.llm_status = 'ok') / count() * 100) AS percent_with_model
FROM events
WHERE event = 'review_completed' AND timestamp > now() - INTERVAL 30 DAY`),
  },
  {
    name: "Learning at work",
    description: "Queue rows moved by learning, reactions on queue rows, and memory changes people make by hand.",
    query: trends([
      event("queue_ranked", { math: "sum", math_property: "moved_by_learning", custom_name: "Rows moved by learning" }),
      event("reaction_given", { math: "total", custom_name: "Queue reactions" }),
      event("memory_changed", { math: "total", custom_name: "Memory changes" }),
    ]),
  },
  {
    name: "Versions in use",
    description: "Active installs by Alden version: who's still on an old one.",
    query: trends([anything()], {
      breakdownFilter: { breakdown: "app_version", breakdown_type: "event" },
      dateRange: { date_from: "-30d" },
      trendsFilter: { display: "ActionsBarStacked" },
    }),
  },
  {
    name: "Install mix",
    description: "OS and how Alden was installed (standalone binary or Node), last 30 days.",
    query: sql(`SELECT properties.os AS os, properties.runtime AS runtime, count(DISTINCT distinct_id) AS installs
FROM events
WHERE timestamp > now() - INTERVAL 30 DAY
GROUP BY os, runtime
ORDER BY installs DESC`),
  },
  {
    name: "Command failures",
    description: "Commands that ended in an error, by command: where people get stuck.",
    query: trends([event("command_run", { math: "total", properties: [is("ok", "false")] })], {
      breakdownFilter: { breakdown: "command", breakdown_type: "event" },
    }),
  },
];

if (print) {
  console.log(JSON.stringify(INSIGHTS, null, 2));
  process.exit(0);
}

const key = process.env.POSTHOG_PERSONAL_API_KEY;
if (!key) throw new Error("Set POSTHOG_PERSONAL_API_KEY (a personal API key, phx_…), or pass --print.");

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${HOST}/api/projects/${PROJECT}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

type Page<T> = { results: T[]; next: string | null };
const dashboards = await api<Page<{ id: number; name: string; deleted?: boolean }>>("GET", "/dashboards/?limit=500");
let dashboard = dashboards.results.find((d) => d.name === DASHBOARD && !d.deleted);
if (!dashboard) {
  dashboard = await api("POST", "/dashboards/", {
    name: DASHBOARD,
    description:
      "Opt-in usage stats from Alden (packages/schema/src/telemetry.ts). Managed by scripts/posthog-dashboard.ts.",
  });
  console.log(`Created the "${DASHBOARD}" dashboard.`);
}
const dashboardId = (dashboard as { id: number }).id;

const existing = await api<Page<{ id: number; name: string; dashboards: number[] }>>(
  "GET",
  `/insights/?saved=true&limit=500&dashboards=[${dashboardId}]`,
);
for (const insight of INSIGHTS) {
  const found = existing.results.find((i) => i.name === insight.name && i.dashboards.includes(dashboardId));
  const body = { name: insight.name, description: insight.description, query: insight.query, saved: true };
  if (found) {
    await api("PATCH", `/insights/${found.id}/`, body);
    console.log(`updated  ${insight.name}`);
  } else {
    await api("POST", "/insights/", { ...body, dashboards: [dashboardId] });
    console.log(`created  ${insight.name}`);
  }
}
const project = await api<{ id: number }>("GET", "/");
console.log(`\n${HOST}/project/${project.id}/dashboard/${dashboardId}`);

export {};
