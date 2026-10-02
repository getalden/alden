import type { Briefing } from "@alden/schema";
import { type ReactNode, useEffect, useState } from "react";
import type { ReviewRequest } from "../api";
import type { BriefingFeedback } from "../feedback";
import type { ReviewRun } from "../reviews";
import { onLinkClick } from "../router";
import { BriefingView } from "./BriefingView";
import { StateCard } from "./StateCard";

const STEPS: { stage: string; done: string; doing: string }[] = [
  { stage: "fetch", done: "Fetched the change", doing: "Fetching the change" },
  { stage: "graph", done: "Found callers", doing: "Finding callers" },
  { stage: "checks", done: "Ran the checks", doing: "Running checks" },
  { stage: "model", done: "Asked the model", doing: "Asking the model" },
];

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Each stage of a running review: done (with how long it took), running, or still to come. */
function Progress({ run, onCancel }: { run: ReviewRun; onCancel: () => void }) {
  const now = useNow(run.running);
  const expected = STEPS.filter(
    (s) => (s.stage !== "graph" || run.request.graph !== false) && (s.stage !== "model" || run.request.llm !== false),
  );
  const seen = new Map(run.stages.map((s, i) => [s.stage, { ...s, end: run.stages[i + 1]?.at }]));
  const current = run.stages.at(-1)?.stage;
  return (
    <div className="brief-body" style={{ maxWidth: 720, gap: 20 }} role="status" aria-live="polite">
      <h2 style={{ font: "500 22px/1.2 var(--font-ui)" }}>Reading the change…</h2>
      <ol className="card steps visually-plain">
        {expected.map((step) => {
          const s = seen.get(step.stage);
          const state = !s ? "wait" : step.stage === current && run.running ? "run" : "done";
          return (
            <li key={step.stage} className={`step ${state}`}>
              <span className={`dot ${state}`} aria-hidden="true">
                {state === "done" ? "✓" : ""}
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span className="label">{state === "done" ? step.done : step.doing}</span>
                {s && <span className="detail">{s.label}</span>}
              </span>
              <span className="time">{s ? (state === "run" ? "…" : seconds((s.end ?? now) - s.at)) : ""}</span>
            </li>
          );
        })}
      </ol>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="faint small mono">{seconds(now - run.startedAt)} so far</span>
        <button type="button" className="btn sm" onClick={onCancel}>
          Stop <kbd>Esc</kbd>
        </button>
      </div>
    </div>
  );
}

interface ReviewPaneProps {
  /** The line above the title: a link to the PR, its branches. */
  crumbs: ReactNode;
  title: string;
  /** Why it's in your queue (or what changed), as chips after a label. */
  why?: { label: string; items: string[] } | undefined;
  run: ReviewRun | undefined;
  controls: ReactNode;
  onStart: (request: ReviewRequest) => void;
  onCancel: () => void;
  request: ReviewRequest;
  emptyHint: string;
  /** Narrow windows show one pane at a time, so a PR needs a way back to the list. */
  backToQueue?: boolean;
  /** Something to know before running it, e.g. why callers won't be found. */
  notice?: ReactNode;
  feedbackFor?: ((briefing: Briefing) => BriefingFeedback) | undefined;
  perReviewUsd?: number | undefined;
}

/** A PR (or your local changes) and its briefing: run it, watch it, read it. */
export function ReviewPane(props: ReviewPaneProps) {
  const { run } = props;
  useEffect(() => {
    if (!run?.running) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run?.running, props.onCancel]);

  return (
    <section aria-labelledby="review-title" style={{ display: "flex", flexDirection: "column" }}>
      <header className="brief-head">
        <div className="crumbs">
          {props.backToQueue && (
            <a className="back-link" href="/" onClick={onLinkClick({ view: "queue" })}>
              ← Queue
            </a>
          )}
          {props.crumbs}
        </div>
        <h1 className="brief-title" id="review-title">
          {props.title}
        </h1>
        {props.why && props.why.items.length > 0 && (
          <div className="why">
            <span className="why-label">{props.why.label}</span>
            {props.why.items.map((w) => (
              <span key={w} className="chip">
                {w}
              </span>
            ))}
          </div>
        )}
      </header>
      <div className="toolbar" role="toolbar" aria-label="Review options">
        {run?.running ? (
          <button type="button" className="btn" onClick={props.onCancel}>
            Stop <kbd>Esc</kbd>
          </button>
        ) : (
          <button type="button" className="btn primary" onClick={() => props.onStart(props.request)}>
            {run?.briefing ? "Brief again" : "Brief me"} <kbd>B</kbd>
          </button>
        )}
        {props.controls}
      </div>
      {props.notice && (
        <div className="notice note-box">
          <span className="q" aria-hidden="true">
            ?
          </span>
          <span className="text">{props.notice}</span>
        </div>
      )}

      {run?.running && <Progress run={run} onCancel={props.onCancel} />}
      {run && !run.running && run.error && (
        <StateCard
          tone={run.error === "Stopped." ? "dashed" : "warn"}
          glyph={run.error === "Stopped." ? "–" : "!"}
          title={run.error === "Stopped." ? "Stopped" : "The briefing didn't finish"}
          body={run.error === "Stopped." ? "Nothing was kept. Brief again when you're ready." : run.error}
          action={
            <button type="button" className="btn primary" onClick={() => props.onStart(props.request)}>
              {run.error === "Stopped." ? "Brief me" : "Retry now"}
            </button>
          }
          alternative={
            run.error !== "Stopped." ? (
              <button
                type="button"
                className="btn quiet"
                onClick={() => navigator.clipboard?.writeText(run.error ?? "")}
              >
                Copy error
              </button>
            ) : undefined
          }
        />
      )}
      {run?.briefing && !run.running && (
        <BriefingView
          briefing={run.briefing}
          feedback={props.feedbackFor?.(run.briefing)}
          perReviewUsd={props.perReviewUsd}
        />
      )}
      {!run && (
        <p className="muted" style={{ padding: "28px 32px", maxWidth: 640 }}>
          {props.emptyHint}
        </p>
      )}
    </section>
  );
}
