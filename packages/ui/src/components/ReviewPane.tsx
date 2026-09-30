import type { Briefing, RankedPullRequest } from "@alden/schema";
import { type ReactNode, useEffect, useState } from "react";
import type { ReviewRequest } from "../api";
import type { BriefingFeedback } from "../feedback";
import { plural } from "../format";
import type { ReviewRun } from "../reviews";
import { onLinkClick } from "../router";
import { BriefingView } from "./BriefingView";

const STAGE_ORDER = ["fetch", "graph", "checks", "model"];

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return <span className="faint mono">{Math.max(0, Math.floor((now - since) / 1000))}s</span>;
}

/** Where a running review is: each stage seen, the current one marked. */
function Progress({ run }: { run: ReviewRun }) {
  const current = run.stages.at(-1);
  return (
    <div className="progress" role="status" aria-live="polite">
      <ol>
        {run.stages
          .toSorted((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage))
          .map((s) => (
            <li key={s.stage} className={s === current && run.running ? "current" : "done"}>
              {s.label}
            </li>
          ))}
      </ol>
      {run.running && <Elapsed since={run.startedAt} />}
    </div>
  );
}

interface ReviewPaneProps {
  title: string;
  subtitle: ReactNode;
  /** The queue row, when the PR came from the queue: its reasons explain why it ranked where it did. */
  row?: RankedPullRequest | undefined;
  run: ReviewRun | undefined;
  controls: ReactNode;
  onStart: (request: ReviewRequest) => void;
  onCancel: () => void;
  request: ReviewRequest;
  emptyHint: string;
  /** Narrow screens show one pane at a time, so a PR needs a way back to the list. */
  backToQueue?: boolean;
  /** Something to know before running it, e.g. why callers won't be found. */
  note?: ReactNode;
  feedbackFor?: ((briefing: Briefing) => BriefingFeedback) | undefined;
}

/** A PR (or your local changes) and its briefing: run it, watch it, read it. */
export function ReviewPane({
  title,
  subtitle,
  row,
  run,
  controls,
  onStart,
  onCancel,
  request,
  emptyHint,
  backToQueue = false,
  note,
  feedbackFor,
}: ReviewPaneProps) {
  return (
    <section className="review-pane" aria-labelledby="review-title">
      <header className="review-head">
        {backToQueue && (
          <a className="back-link" href="/" onClick={onLinkClick({ view: "queue" })}>
            ← Back to the queue
          </a>
        )}
        <h1 id="review-title">{title}</h1>
        <div className="muted review-sub">{subtitle}</div>
        {row && row.reasons.length > 0 && (
          <p className="faint small">
            In your queue because: {row.reasons.join(" · ")}
            {row.pr.changedFiles > 0 ? ` · ${plural(row.pr.changedFiles, "file")}` : ""}
          </p>
        )}
        <div className="review-actions">
          {run?.running ? (
            <button type="button" className="btn" onClick={onCancel}>
              Stop
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={() => onStart(request)}>
              {run?.briefing ? "Review again" : "Brief me"}
            </button>
          )}
          {controls}
        </div>
        {note && <p className="faint small">{note}</p>}
      </header>

      {run && (run.running || run.stages.length > 0) && !run.briefing && <Progress run={run} />}
      {run?.error && <p className="banner error">{run.error}</p>}
      {run?.briefing && <BriefingView briefing={run.briefing} feedback={feedbackFor?.(run.briefing)} />}
      {!run && <p className="muted pad">{emptyHint}</p>}
    </section>
  );
}
