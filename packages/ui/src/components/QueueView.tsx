import type { CiState, RankedPullRequest, RankedQueue } from "@alden/schema";
import { useMemo, useState } from "react";
import { formatWait } from "../format";
import { onLinkClick, routePath } from "../router";
import { Mark } from "./Mark";
import { StateCard } from "./StateCard";

export type Reaction = "up" | "down" | "dismiss";

const CI: Record<CiState, { glyph: string; label: string }> = {
  success: { glyph: "✓", label: "CI" },
  failure: { glyph: "✕", label: "CI" },
  pending: { glyph: "◌", label: "CI" },
  none: { glyph: "–", label: "no CI" },
};

const REACTED: Record<Reaction, string> = {
  up: "Noted. PRs like this rank higher.",
  down: "Noted. PRs like this rank lower.",
  dismiss: "Hidden until it changes",
};

export const prKey = (pr: { repo: string; number: number }) => `${pr.repo}#${pr.number}`;

/** Reasons that came from your own feedback ("ranked higher: …") get their own line, not a chip. */
export const isLearnedReason = (reason: string) => /^ranked (higher|lower):/.test(reason);

interface QueueViewProps {
  queue: RankedQueue | undefined;
  error: string | undefined;
  loading: boolean;
  repoFilter: string;
  onRepoFilter: (repo: string) => void;
  onRefresh: () => void;
  selected: string | undefined;
  /** No GitHub sign-in: say how to fix it instead of an error. */
  signedOut?: boolean;
  reactions?: Record<string, Reaction | undefined>;
  onReact?: (key: string, reaction: Reaction) => void;
  /** PRs (lowercased "owner/repo#12") with a briefing ready from the desktop app's background run. */
  ready?: Set<string>;
}

/** The PRs waiting on you: "Needs you", ranked, then "Fast-track". Every row says why it ranks where it does. */
export function QueueView({
  queue,
  error,
  loading,
  repoFilter,
  onRepoFilter,
  onRefresh,
  selected,
  signedOut = false,
  reactions = {},
  onReact,
  ready,
}: QueueViewProps) {
  const [showDismissed, setShowDismissed] = useState(false);
  const repos = useMemo(
    () => [...new Set([...(queue?.needsYou ?? []), ...(queue?.fastTrack ?? [])].map((r) => r.pr.repo))].sort(),
    [queue],
  );
  const keep = (r: RankedPullRequest) => !repoFilter || r.pr.repo === repoFilter;
  const needsYou = queue?.needsYou.filter(keep) ?? [];
  const fastTrack = queue?.fastTrack.filter(keep) ?? [];
  const dismissed = queue?.dismissed?.filter(keep) ?? [];

  if (signedOut) {
    return (
      <StateCard
        tone="solid"
        glyph="GH"
        title="Sign in to GitHub"
        body="Alden uses your own GitHub sign-in to read the PRs waiting on you. Run this in a terminal, then refresh."
        command="alden auth login"
        action={
          <button type="button" className="btn primary" onClick={onRefresh}>
            I've signed in
          </button>
        }
      />
    );
  }
  if (!queue && loading) {
    return (
      <div aria-busy="true" role="status">
        <div className="list-head">
          <span className="label">Reading your queue…</span>
        </div>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skeleton" />
        ))}
      </div>
    );
  }
  if (!queue && error) {
    return (
      <StateCard
        tone="warn"
        glyph="!"
        title="GitHub didn't answer"
        body={error}
        action={
          <button type="button" className="btn primary" onClick={onRefresh}>
            Retry now
          </button>
        }
      />
    );
  }

  return (
    <section aria-labelledby="needs-you">
      {(repos.length > 1 || error) && (
        <div className="list-tools">
          {repos.length > 1 && (
            <select
              className="input"
              aria-label="Repository"
              value={repoFilter}
              onChange={(e) => onRepoFilter(e.target.value)}
            >
              <option value="">All repos</option>
              {repos.map((repo) => (
                <option key={repo} value={repo}>
                  {repo}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="btn sm" onClick={onRefresh} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      )}
      {error && <p className="banner error side-note">{error}</p>}
      {queue?.warnings.map((w) => (
        <p key={w} className="banner side-note">
          {w}
        </p>
      ))}

      {queue && needsYou.length === 0 && fastTrack.length === 0 && (
        <div className="empty-list">
          <Mark size={40} outline />
          <span className="big">Nothing is waiting on you.</span>
          <span className="muted small">
            {repoFilter
              ? `No open PRs in ${repoFilter} request your review.`
              : "No open PRs request your review, directly or through your teams."}
          </span>
          <button type="button" className="link-button small" onClick={onRefresh} disabled={loading}>
            {loading ? "Checking…" : "r to refresh now"}
          </button>
        </div>
      )}

      {needsYou.length > 0 && (
        <>
          <div className="list-head">
            <h2 className="label" id="needs-you">
              Needs you · {needsYou.length}
            </h2>
            <span className="hint">j k move · b brief · + − x react</span>
          </div>
          <ol className="visually-plain" aria-labelledby="needs-you">
            {needsYou.map((row, i) => (
              <li key={prKey(row.pr)}>
                <PrRow
                  row={row}
                  rank={i + 1}
                  selected={selected === prKey(row.pr)}
                  reaction={reactions[prKey(row.pr)]}
                  onReact={onReact}
                  ready={ready?.has(prKey(row.pr).toLowerCase()) ?? false}
                />
              </li>
            ))}
          </ol>
        </>
      )}

      {fastTrack.length > 0 && (
        <>
          <div className="list-head lane">
            <h2 className="label" id="fast-track">
              Fast-track · {fastTrack.length}
            </h2>
            <span className="hint">small, low risk, CI green</span>
          </div>
          <ol className="visually-plain" aria-labelledby="fast-track">
            {fastTrack.map((row) => {
              const route = { view: "queue" as const, pr: { repo: row.pr.repo, number: row.pr.number } };
              return (
                <li key={prKey(row.pr)}>
                  <a
                    className="fast-row"
                    href={routePath(route)}
                    onClick={onLinkClick(route)}
                    aria-current={selected === prKey(row.pr) ? "true" : undefined}
                    data-pr={prKey(row.pr)}
                  >
                    <span className="pr-body" style={{ gap: 3 }}>
                      <span className="fast-title" title={row.pr.title}>
                        {row.pr.title}
                      </span>
                      <span className="pr-meta">
                        <span>
                          {row.pr.repo} #{row.pr.number} · {row.fastTrack}
                        </span>
                        <span>
                          <span className="add">+{row.pr.additions}</span>{" "}
                          <span className="del">−{row.pr.deletions}</span>
                        </span>
                      </span>
                    </span>
                    <span className="wait">{formatWait(row.waitingHours)}</span>
                  </a>
                </li>
              );
            })}
          </ol>
        </>
      )}

      {dismissed.length > 0 && (
        <div className="list-foot">
          <span>{dismissed.length} dismissed, until they change ·</span>
          <button type="button" className="link-button" onClick={() => setShowDismissed((v) => !v)}>
            {showDismissed ? "hide" : "show"}
          </button>
        </div>
      )}
      {showDismissed &&
        dismissed.map((row) => (
          <div key={prKey(row.pr)} className="fast-row">
            <span className="pr-body" style={{ gap: 3 }}>
              <span className="fast-title">{row.pr.title}</span>
              <span className="pr-meta">
                {row.pr.repo} #{row.pr.number}
              </span>
            </span>
            {onReact && (
              <button type="button" className="btn xs" onClick={() => onReact(prKey(row.pr), "dismiss")}>
                Undo
              </button>
            )}
          </div>
        ))}
    </section>
  );
}

function PrRow(props: {
  row: RankedPullRequest;
  rank: number;
  selected: boolean;
  reaction: Reaction | undefined;
  onReact: ((key: string, reaction: Reaction) => void) | undefined;
  ready?: boolean;
}) {
  const { row, rank, selected, reaction, onReact, ready = false } = props;
  const { pr } = row;
  const key = prKey(pr);
  const route = { view: "queue" as const, pr: { repo: pr.repo, number: pr.number } };
  const ci = CI[pr.ci];
  // The wait and failing CI have their own places in the row; learned reasons get their own line.
  const learned = row.reasons.find(isLearnedReason);
  const reasons = row.reasons.filter((r) => !/^waiting \d/.test(r) && !/^CI failing/.test(r) && !isLearnedReason(r));
  const react = (r: Reaction) => () => onReact?.(key, r);
  return (
    <div className={`pr-row${selected ? " selected" : ""}${reaction === "dismiss" ? " dismissed" : ""}`} data-pr={key}>
      <span className="pr-rank">{String(rank).padStart(2, "0")}</span>
      <span className="pr-body">
        <a
          className="pr-title stretch"
          href={routePath(route)}
          onClick={onLinkClick(route)}
          aria-current={selected ? "true" : undefined}
        >
          {pr.isDraft && <span className="chip">Draft</span>} {pr.title}
        </a>
        <span className="pr-meta">
          <span>
            {pr.repo} #{pr.number}
          </span>
          <span>{pr.author ?? "ghost"}</span>
          <span>
            <span className="add">+{pr.additions}</span> <span className="del">−{pr.deletions}</span>
          </span>
        </span>
        {(reasons.length > 0 || row.waitingOnAuthor || ready) && (
          <span className="pr-chips">
            {ready && <span className="chip ready">✓ Briefing ready</span>}
            {row.waitingOnAuthor && pr.author && <span className="chip">CI failing: ping @{pr.author}</span>}
            {reasons.map((reason) => (
              <span key={reason} className="chip">
                {reason}
              </span>
            ))}
          </span>
        )}
        {learned && (
          <span className={`learned-line${learned.startsWith("ranked lower") ? " down" : ""}`}>
            <span aria-hidden="true">{learned.startsWith("ranked lower") ? "↓" : "↑"}</span>
            <span>{learned}</span>
          </span>
        )}
        {onReact && (selected || reaction) && (
          <span className="reactions">
            <button
              type="button"
              className={`btn xs${reaction === "up" ? " on" : ""}`}
              aria-pressed={reaction === "up"}
              onClick={react("up")}
            >
              ↑ Useful
            </button>
            <button
              type="button"
              className={`btn xs${reaction === "down" ? " on" : ""}`}
              aria-pressed={reaction === "down"}
              onClick={react("down")}
            >
              ↓ Not useful
            </button>
            <button
              type="button"
              className={`btn xs${reaction === "dismiss" ? " on" : ""}`}
              aria-pressed={reaction === "dismiss"}
              onClick={react("dismiss")}
            >
              × Dismiss
            </button>
            {reaction && (
              <span className="react-note" role="status">
                {REACTED[reaction]}
              </span>
            )}
          </span>
        )}
      </span>
      <span className="pr-side">
        <span className={`ci ${pr.ci}`} title={`CI ${pr.ci === "none" ? "not set up" : pr.ci}`}>
          {ci.glyph} {ci.label}
        </span>
        <span
          className={`wait${row.waitingHours >= 24 ? " hot" : ""}`}
          title={`Waiting ${Math.round(row.waitingHours)} hours`}
        >
          {formatWait(row.waitingHours)}
        </span>
      </span>
    </div>
  );
}
