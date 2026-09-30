import type { CiState, RankedPullRequest, RankedQueue } from "@alden/schema";
import { useMemo } from "react";
import { formatWait } from "../format";
import { onLinkClick, routePath } from "../router";

const CI: Record<CiState, { label: string; tone: string }> = {
  success: { label: "CI passing", tone: "ok" },
  failure: { label: "CI failing", tone: "high" },
  pending: { label: "CI running", tone: "" },
  none: { label: "No CI", tone: "" },
};

export const prKey = (pr: { repo: string; number: number }) => `${pr.repo}#${pr.number}`;

interface QueueViewProps {
  queue: RankedQueue | undefined;
  error: string | undefined;
  loading: boolean;
  repoFilter: string;
  onRepoFilter: (repo: string) => void;
  onRefresh: () => void;
  selected: string | undefined;
}

/** The PRs waiting on you: "Needs you", ranked, then "Fast-track". Every row says why it ranks where it does. */
export function QueueView({ queue, error, loading, repoFilter, onRepoFilter, onRefresh, selected }: QueueViewProps) {
  const repos = useMemo(
    () => [...new Set([...(queue?.needsYou ?? []), ...(queue?.fastTrack ?? [])].map((r) => r.pr.repo))].sort(),
    [queue],
  );
  const keep = (r: RankedPullRequest) => !repoFilter || r.pr.repo === repoFilter;
  const needsYou = queue?.needsYou.filter(keep) ?? [];
  const fastTrack = queue?.fastTrack.filter(keep) ?? [];

  return (
    <section aria-labelledby="queue-title">
      <div className="toolbar">
        <h1 id="queue-title">Your review queue</h1>
        {repos.length > 1 && (
          <label>
            <span className="visually-hidden">Repository</span>
            <select value={repoFilter} onChange={(e) => onRepoFilter(e.target.value)}>
              <option value="">All repos</option>
              {repos.map((repo) => (
                <option key={repo} value={repo}>
                  {repo}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className="btn small" onClick={onRefresh} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && <p className="banner error">{error}</p>}
      {queue?.warnings.map((w) => (
        <p key={w} className="banner">
          {w}
        </p>
      ))}

      {!queue && loading && (
        <div className="lane">
          <div className="pr-list">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton" />
            ))}
          </div>
        </div>
      )}

      {queue && needsYou.length === 0 && fastTrack.length === 0 && (
        <div className="state">
          <h2>Nothing is waiting on you</h2>
          <p>
            {repoFilter
              ? `No open PRs in ${repoFilter} request your review.`
              : "No open PRs request your review, directly or through your teams."}
          </p>
        </div>
      )}

      {needsYou.length > 0 && (
        <Lane title="Needs you" hint="highest priority first" rows={needsYou} start={1} selected={selected} />
      )}
      {fastTrack.length > 0 && (
        <Lane
          title="Fast-track"
          hint="small, green and low-risk; still your call"
          rows={fastTrack}
          start={needsYou.length + 1}
          selected={selected}
        />
      )}
    </section>
  );
}

function Lane(props: {
  title: string;
  hint: string;
  rows: RankedPullRequest[];
  start: number;
  selected?: string | undefined;
}) {
  return (
    <div className="lane">
      <h2 className="lane-head">
        {props.title} <span className="faint">{props.rows.length}</span>
        <span className="hint">{props.hint}</span>
      </h2>
      <ol className="pr-list">
        {props.rows.map((row, i) => (
          <li key={prKey(row.pr)}>
            <PrRow row={row} rank={props.start + i} selected={props.selected === prKey(row.pr)} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function PrRow({ row, rank, selected }: { row: RankedPullRequest; rank: number; selected: boolean }) {
  const { pr } = row;
  const route = { view: "queue" as const, pr: { repo: pr.repo, number: pr.number } };
  const ci = CI[pr.ci];
  // The wait and the failing CI already have their own places in the row.
  const reasons = row.reasons.filter((r) => !/^waiting \d/.test(r) && !/^CI failing/.test(r));
  return (
    <a
      href={routePath(route)}
      onClick={onLinkClick(route)}
      className={`pr-row${row.waitingOnAuthor ? " waiting" : ""}`}
      aria-current={selected ? "true" : undefined}
      data-pr={prKey(pr)}
    >
      <span className="pr-rank">{rank}</span>
      <span className="pr-title" title={pr.title}>
        {pr.isDraft && <span className="badge">Draft</span>} {pr.title}
      </span>
      <span className="pr-wait" title={`Waiting ${Math.round(row.waitingHours)} hours`}>
        {formatWait(row.waitingHours)}
      </span>
      <span className="pr-sub">
        <span className="mono">
          {pr.repo}#{pr.number}
        </span>
        <span>{pr.author ? `@${pr.author}` : "ghost"}</span>
        <span className="size mono">
          <span className="add">+{pr.additions}</span> <span className="del">−{pr.deletions}</span>
        </span>
        <span className={`badge ${ci.tone}`}>{ci.label}</span>
        {row.fastTrack && <span className="badge accent">{row.fastTrack}</span>}
        {row.waitingOnAuthor && pr.author && <span className="badge high">Ping @{pr.author}</span>}
      </span>
      {reasons.length > 0 && (
        <span className="pr-reasons">
          {reasons.map((reason) => (
            <span key={reason} className="badge">
              {reason}
            </span>
          ))}
        </span>
      )}
    </a>
  );
}
