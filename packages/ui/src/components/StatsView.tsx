import {
  type Distribution,
  REVIEW_TIME_SMALL_SAMPLE,
  type RepoStats,
  type ReviewTimeGroup,
  type ReviewTimeStats,
} from "@alden/schema";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import type { Api, Session } from "../api";
import { plural } from "../format";
import { Segmented } from "./Segmented";

/** "45m", "9h", "2d 12h", "14d+" (at the horizon: at least that long). */
export function formatHours(hours: number | null, horizon: number): string {
  if (hours === null) return "–";
  if (hours >= horizon) return `${Math.round(horizon / 24)}d+`;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours - days * 24);
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

type MetricKey = "timeToFirstReview" | "cycleTime";
const METRICS: Record<MetricKey, { label: string; week: "timeToFirstReviewMedianHours" | "cycleTimeMedianHours" }> = {
  timeToFirstReview: { label: "Time to first review", week: "timeToFirstReviewMedianHours" },
  cycleTime: { label: "Review cycle time", week: "cycleTimeMedianHours" },
};

/** One metric as a figure: the latest median, and how it moved since the split. */
function Tile({ stats, metric }: { stats: RepoStats; metric: MetricKey }) {
  const m = stats[metric];
  const h = stats.horizonHours;
  const now: Distribution = stats.split && m.after && m.after.count > 0 ? m.after : m.all;
  const before = stats.split ? m.before : null;
  let delta: { text: string; tone: "good" | "bad" | "flat" } | null = null;
  if (before?.medianHours && now.medianHours !== null && stats.split && m.after && m.after.count > 0) {
    const ratio = now.medianHours / before.medianHours;
    delta =
      Math.abs(ratio - 1) < 0.05
        ? { text: "No change", tone: "flat" }
        : ratio < 1
          ? { text: `↓ ${Math.round((1 - ratio) * 100)}% faster`, tone: "good" }
          : {
              text: `↑ ${ratio >= 2 ? `${ratio.toFixed(1)}×` : `${Math.round((ratio - 1) * 100)}%`} slower`,
              tone: "bad",
            };
  }
  return (
    <div className="card tile">
      <div className="tile-label">{METRICS[metric].label}</div>
      <div className="tile-row">
        <span className="tile-value">{formatHours(now.medianHours, h)}</span>
        {delta && <span className="tile-was">was {formatHours(before?.medianHours ?? null, h)}</span>}
      </div>
      {delta && <div className={`tile-delta ${delta.tone}`}>{delta.text}</div>}
      <div className="tile-sub">
        median of {plural(now.count, "PR")}
        {stats.split && m.after && m.after.count > 0 ? ` since ${shortDate(stats.split.at)}` : ""} · p90{" "}
        {formatHours(now.p90Hours, h)}
      </div>
    </div>
  );
}

/**
 * Weekly medians as columns: one series, so no legend (the heading names it). Each column carries its own tooltip on
 * hover and focus; the table below has every value.
 */
function WeeklyChart({ stats, metric }: { stats: RepoStats; metric: MetricKey }) {
  const [active, setActive] = useState<number>();
  const titleId = useId();
  const weeks = stats.weeks;
  const h = stats.horizonHours;
  const width = 720;
  const height = 220;
  const pad = { top: 28, right: 12, bottom: 28, left: 44 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const band = plotW / Math.max(1, weeks.length);
  const barW = Math.min(24, band - 2);
  const y = (hours: number) => pad.top + plotH - (Math.min(hours, h) / h) * plotH;
  const ticks = [0, h / 2, h];
  const splitAt = stats.split?.at;
  const splitIndex = splitAt ? weeks.findIndex((w) => w.week >= splitAt.slice(0, 10)) : -1;
  const labelEvery = Math.ceil(weeks.length / 8);
  const tip = active === undefined ? undefined : weeks[active];

  return (
    <figure className="chart card chart-card" aria-labelledby={titleId}>
      <div className="section-head">
        <figcaption id={titleId} className="tile-label" style={{ color: "var(--ink)" }}>
          Weekly median {METRICS[metric].label.toLowerCase()}, by the week PRs were ready for review
        </figcaption>
        {splitIndex > 0 && (
          <span className="legend">
            <span>
              <i />
              Before
            </span>
            <span>
              <i className="acc" />
              With Alden
            </span>
          </span>
        )}
      </div>
      <div className="chart-frame">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Weekly median ${METRICS[metric].label}`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} />
              <text className="tick" x={pad.left - 6} y={y(t) + 4} textAnchor="end">
                {t === 0 ? "0" : formatHours(t, h + 1)}
              </text>
            </g>
          ))}
          {splitAt && splitIndex > 0 && (
            <g>
              <line
                className="split"
                x1={pad.left + band * splitIndex}
                x2={pad.left + band * splitIndex}
                y1={pad.top - 20}
                y2={pad.top + plotH}
              />
              <text className="tick" x={pad.left + band * splitIndex + 4} y={pad.top - 10}>
                Alden from {shortDate(splitAt)}
              </text>
            </g>
          )}
          <line className="base" x1={pad.left} x2={width - pad.right} y1={pad.top + plotH} y2={pad.top + plotH} />
          {weeks.map((w, i) => {
            const value = w[METRICS[metric].week];
            const x = pad.left + band * i + (band - barW) / 2;
            const after = splitIndex > 0 ? i >= splitIndex : true;
            return (
              <g key={w.week} className={`bar-group${active === i ? " active" : ""}`}>
                {value !== null && value > 0 && (
                  <path className={after ? "bar-after" : "bar-before"} d={column(x, y(value), barW, pad.top + plotH)} />
                )}
                {(i % labelEvery === 0 || i === weeks.length - 1) && (
                  <text className="tick" x={pad.left + band * i + band / 2} y={height - 8} textAnchor="middle">
                    {shortDate(w.week)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {/* Hit targets: a button per week over its whole column, for hover, focus and screen readers alike. */}
        <div
          className="bar-targets"
          style={{ left: `${(pad.left / width) * 100}%`, right: `${(pad.right / width) * 100}%` }}
        >
          {weeks.map((w, i) => {
            const value = w[METRICS[metric].week];
            return (
              <button
                key={w.week}
                type="button"
                className="bar-target"
                aria-label={`Week of ${shortDate(w.week)}: ${value === null ? "nothing to measure" : `${formatHours(value, h)} median`}, ${plural(w.prs, "PR")}`}
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive(undefined)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(undefined)}
              />
            );
          })}
        </div>
        {tip && active !== undefined && (
          <div
            className="chart-tip"
            style={{ left: `${((pad.left + band * active + band / 2) / width) * 100}%` }}
            role="presentation"
          >
            <strong>{tip[METRICS[metric].week] === null ? "–" : formatHours(tip[METRICS[metric].week], h)}</strong>
            <span className="muted">
              week of {shortDate(tip.week)} · {plural(tip.prs, "PR")}
            </span>
          </div>
        )}
      </div>
    </figure>
  );
}

/** A column with a 4px rounded top, square at the baseline. */
function column(x: number, top: number, w: number, base: number): string {
  const r = Math.min(4, w / 2, base - top);
  return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`;
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

/**
 * Time to review: your own reviews sent with Alden, from the sessions recorded on this machine. The two medians with
 * and without the model side by side, each with how many reviews it rests on; no "faster" or "slower": too few
 * reviews, and too much else differs between them, for that to be honest.
 */
export function ReviewTimeSection({ stats }: { stats: ReviewTimeStats }) {
  const [days, setDays] = useState(30);
  const shown = stats.windows.find((w) => w.days === days) ?? stats.windows[0];
  const horizonDays = Math.round(stats.horizonHours / 24);
  const horizon = stats.horizonHours * 60;
  const longest = stats.windows.at(-1);
  const anything = stats.windows.some((w) => w.all.count > 0);
  const row = (label: string, g: ReviewTimeGroup) => (
    <tr key={label}>
      <th scope="row">{label}</th>
      <td>{g.count === 0 ? "–" : formatMinutes(g.activeMedianMinutes)}</td>
      <td>{g.count === 0 ? "–" : formatMinutes(g.wallMedianMinutes, horizon)}</td>
      <td>
        {g.count}
        {g.count > 0 && g.small ? <span className="faint"> · few</span> : null}
      </td>
    </tr>
  );
  const small =
    shown && [shown.withModel, shown.withoutModel].some((g) => g.count > 0 && g.count < REVIEW_TIME_SMALL_SAMPLE);
  return (
    <section className="card panel" aria-labelledby="review-time-title">
      <div className="section-head">
        <h2 className="tile-label" id="review-time-title" style={{ color: "var(--ink)" }}>
          Time to review
        </h2>
        {anything && (
          <Segmented label="Reviews opened in the last">
            {stats.windows.map((w) => (
              <button key={w.days} type="button" aria-pressed={w.days === days} onClick={() => setDays(w.days)}>
                {w.days} days
              </button>
            ))}
          </Segmented>
        )}
      </div>
      <p className="muted small">
        Your reviews sent with Alden, from this machine, by the day you first opened the briefing. Active is time with
        the PR in front of you in Alden (idle stretches over 2 minutes left out); open to send is from first opening its
        briefing to sending your review.
      </p>
      {!stats.enabled && (
        <p className="banner">
          Off: Alden isn't recording how long reviews take. Turn it on in Settings → Time to review.
        </p>
      )}
      {!anything || !shown ? (
        <p className="muted">
          {longest && longest.excluded.tooRecent > 0
            ? `Nothing to show yet: ${plural(longest.excluded.tooRecent, "review")} opened in the last ${horizonDays} days ${longest.excluded.tooRecent === 1 ? "counts" : "count"} once ${horizonDays} days old.`
            : "No reviews timed yet: open a PR's briefing in Alden, then send your review from Alden."}
        </p>
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Last {shown.days} days</th>
                <th scope="col">Median active</th>
                <th scope="col">Median open to send</th>
                <th scope="col">Reviews</th>
              </tr>
            </thead>
            <tbody>
              {row("With the model", shown.withModel)}
              {row("Without the model", shown.withoutModel)}
            </tbody>
          </table>
          <p className="faint small">
            {small &&
              `Few reviews (under ${REVIEW_TIME_SMALL_SAMPLE}): one review can swing these medians, so read them as anecdotes, not a trend. `}
            {shown.excluded.tooRecent > 0 &&
              `${plural(shown.excluded.tooRecent, "review")} opened in the last ${horizonDays} days ${shown.excluded.tooRecent === 1 ? "isn't" : "aren't"} counted yet, so slow reviews aren't left out. `}
            {shown.excluded.notSent > 0 &&
              `${plural(shown.excluded.notSent, "briefing")} opened and never sent from Alden ${shown.excluded.notSent === 1 ? "isn't" : "aren't"} counted. `}
            {shown.all.estimated > 0 &&
              `${plural(shown.all.estimated, "review")} from a terminal or AI tool: active time there is briefing to send, at most 30 minutes. `}
            Open to send is capped at {horizonDays} days.
          </p>
        </>
      )}
    </section>
  );
}

/** A repo's review speed from GitHub: before and after Alden, and week by week. */
export function StatsView({ api, session }: { api: Api; session: Session }) {
  const [repo, setRepo] = useState(session.repo?.repos[0] ?? "");
  const [days, setDays] = useState("90");
  const [since, setSince] = useState("");
  const [metric, setMetric] = useState<MetricKey>("timeToFirstReview");
  const [stats, setStats] = useState<RepoStats>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [reviewTime, setReviewTime] = useState<ReviewTimeStats>();

  const load = useCallback(
    (refresh = false) => {
      if (!repo) return;
      setLoading(true);
      setError(undefined);
      api
        .stats({ repo, days: Number(days), ...(since ? { since } : {}), refresh })
        .then(setStats, (e: unknown) => setError((e as Error).message))
        .finally(() => setLoading(false));
    },
    [api, repo, days, since],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on open; later loads are the form's
  useEffect(() => load(), []);

  // Your own time to review: from this machine, whichever repo is picked above.
  useEffect(() => {
    Promise.resolve()
      .then(() => api.reviewTime())
      .then(setReviewTime, () => setReviewTime(undefined));
  }, [api]);

  function submit(event: FormEvent) {
    event.preventDefault();
    load();
  }

  return (
    <section className="page-inner" aria-labelledby="stats-title">
      <div className="section-head">
        <h1 className="page-title" id="stats-title">
          Review speed
        </h1>
        {stats && (
          <span className="faint mono small">
            {stats.repo} · each PR judged over {Math.round(stats.horizonHours / 24)} days
          </span>
        )}
      </div>
      <form className="filters" onSubmit={submit}>
        <label className="field">
          Repo
          <input
            className="input mono"
            type="text"
            value={repo}
            placeholder="owner/name"
            onChange={(e) => setRepo(e.target.value)}
          />
        </label>
        <label className="field">
          PRs opened in the last
          <select className="input" value={days} onChange={(e) => setDays(e.target.value)}>
            {["30", "60", "90", "180", "365"].map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Compare from
          <input className="input" type="date" value={since} onChange={(e) => setSince(e.target.value)} />
        </label>
        <button type="submit" className="btn primary" disabled={loading || !repo}>
          {loading ? "Loading…" : "Show"}
        </button>
        {stats && (
          <button type="button" className="btn" onClick={() => load(true)} disabled={loading}>
            Refresh
          </button>
        )}
      </form>

      {!repo && <p className="muted">Start alden ui in a clone of a repo, or type one above.</p>}
      {error && <p className="banner error">{error}</p>}
      {loading && !stats && <div className="card skeleton" style={{ height: 220 }} />}

      {stats && (
        <>
          <p className="muted small">
            {stats.repo} · PRs ready for review, each judged over {Math.round(stats.horizonHours / 24)} days.{" "}
            {stats.split && (stats.timeToFirstReview.after?.count ?? 0) === 0
              ? `Too soon to compare: PRs ready from ${shortDate(stats.split.at)} can be judged from ${shortDate(new Date(Date.parse(stats.split.at) + stats.horizonHours * 3_600_000).toISOString())}.`
              : stats.split
                ? `Before and after ${shortDate(stats.split.at)}, ${stats.split.source === "since" ? "the date you picked" : "your first review with Alden here"}.`
                : "No before and after yet: Alden starts the clock the first time you review a PR here, or pick a date."}
          </p>
          <div className="tiles">
            <Tile stats={stats} metric="timeToFirstReview" />
            <Tile stats={stats} metric="cycleTime" />
          </div>

          <Segmented label="Chart" style={{ alignSelf: "flex-start" }}>
            {(Object.keys(METRICS) as MetricKey[]).map((key) => (
              <button key={key} type="button" aria-pressed={metric === key} onClick={() => setMetric(key)}>
                {METRICS[key].label}
              </button>
            ))}
          </Segmented>
          {stats.weeks.length > 0 ? (
            <WeeklyChart stats={stats} metric={metric} />
          ) : (
            <p className="muted">No PRs old enough to judge in this window.</p>
          )}

          <details className="table-view">
            <summary className="small muted">Table</summary>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Week of</th>
                  <th scope="col">PRs</th>
                  <th scope="col">Time to first review</th>
                  <th scope="col">Review cycle time</th>
                </tr>
              </thead>
              <tbody>
                {stats.weeks.map((w) => (
                  <tr key={w.week}>
                    <td>{shortDate(w.week)}</td>
                    <td>{w.prs}</td>
                    <td>{formatHours(w.timeToFirstReviewMedianHours, stats.horizonHours)}</td>
                    <td>{formatHours(w.cycleTimeMedianHours, stats.horizonHours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>

          <p className="faint small">
            {plural(stats.prs, "PR")} opened. Left out: {stats.excluded.tooRecent} too recent to judge,{" "}
            {stats.excluded.noReview} merged or closed without a review, {stats.excluded.bots} by bots,{" "}
            {stats.excluded.drafts} still drafts. {stats.stillWaiting.review} still waiting for a review count as{" "}
            {Math.round(stats.horizonHours / 24)} days.
            {stats.truncated ? " GitHub's search stops at 1,000 PRs, so older ones are missing." : ""}
          </p>
        </>
      )}

      {reviewTime && <ReviewTimeSection stats={reviewTime} />}
    </section>
  );
}
