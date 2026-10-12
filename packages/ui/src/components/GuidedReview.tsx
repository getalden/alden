import type { Briefing, RelatedFile } from "@alden/schema";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { cachedDiff } from "../diff";
import type { BriefingFeedback } from "../feedback";
import {
  blobUrl,
  type CommentPlace,
  excerptAround,
  type GuidedStep,
  guidedKey,
  guidedSteps,
  leaveGuided,
  type PrDiff,
  type PrDiffFile,
  RELATED_LABEL,
  saveProgress,
  useGuidedProgress,
} from "../guided";
import { onScreen, useRecordSeen, useSeenAfter } from "../seen";
import { eyesItem, FromNoteLine, findingItem, NoteOffer, SEVERITY, Verdicts } from "./BriefingView";
import { CodeExcerpt } from "./CodeExcerpt";
import { typing } from "./Comments";

export interface GuidedReviewProps {
  briefing: Briefing;
  feedback?: BriefingFeedback | undefined;
  /** Fetches a PR's diff ("owner/repo#12") for the code at each step. Absent for local changes: steps name the place. */
  loadDiff?: ((pr: string) => Promise<PrDiff>) | undefined;
  /** Opens a comment on a step's place. Without it, steps have no Comment action. */
  onComment?: ((place: CommentPlace) => void) | undefined;
  /** "Finish: review your comments" on the last step; leaving the walk-through happens either way. */
  onFinish?: (() => void) | undefined;
  /** The brief, shown when you're not walking through. */
  children?: ReactNode;
}

export type DiffState =
  | { state: "idle" | "loading" }
  | { state: "ok"; diff: PrDiff }
  | { state: "error"; message: string };

const where = (path: string, line?: number) => `${path}${line ? `:${line}` : ""}`;

/**
 * Walk through: the places that need your eyes one at a time, in Alden's order, then the model's other findings as
 * extra steps. Each step shows why it's there, the code at the place, and the files to look at too. g starts (or
 * resumes), n and p move, Esc goes back to the brief. Where you are is kept while the app is open, and anything can
 * start or leave it through `startGuided` and `leaveGuided` (guided.ts).
 */
export function GuidedReview({ briefing, feedback, loadDiff, onComment, onFinish, children }: GuidedReviewProps) {
  const { steps, core } = useMemo(() => guidedSteps(briefing), [briefing]);
  const key = guidedKey(briefing);
  const progress = useGuidedProgress(key);
  const step = Math.min(progress.step, Math.max(0, steps.length - 1));
  const active = progress.active && steps.length > 0;
  const set = (next: { active: boolean; step: number }) => saveProgress(key, next);

  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const go = (to: number) => set({ active: true, step: Math.max(0, Math.min(steps.length - 1, to)) });
  const leave = () => {
    leaveGuided(key);
    // Back to the brief's Walk through button, so the keyboard isn't lost.
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>("[data-walk-start]")?.focus());
  };
  const finish = () => {
    set({ active: false, step: 0 });
    onFinish?.();
  };
  // Focus follows the step: its heading, so a screen reader reads the new title. Not when the PR opens on a step.
  const shownAt = useRef(active ? step : -1);
  useEffect(() => {
    const was = shownAt.current;
    shownAt.current = active ? step : -1;
    if (!active || was === step) return;
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [active, step]);

  const latest = useRef({ active, step, go, leave, count: steps.length });
  latest.current = { active, step, go, leave, count: steps.length };
  useEffect(() => {
    if (steps.length === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || typing(event.target)) return;
      const now = latest.current;
      if (!now.active) {
        if (event.key !== "g") return;
        now.go(now.step);
      } else if (event.key === "n") {
        if (now.step < now.count - 1) now.go(now.step + 1);
      } else if (event.key === "p") {
        if (now.step > 0) now.go(now.step - 1);
      } else if (event.key === "Escape") {
        // An open menu closes first.
        if (document.activeElement?.closest('[role="menu"]')) return;
        now.leave();
        // Before the queue's own Esc, which on narrow windows goes back to the list.
        event.stopPropagation();
      } else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [steps.length]);

  const diff = useBriefingDiff(briefing, active ? loadDiff : undefined);

  // A step you've had in front of you for 1.5 s counts as seen: its place, at the head commit the briefing is of. Only
  // for a PR's places (never your local changes), and only steps with a place in the code.
  const record = useRecordSeen();
  const briefed = briefing.target.kind === "pr" ? briefing.target : undefined;
  const shown = active ? steps[step] : undefined;
  const seenPr = briefed?.headSha ? { pr: `${briefed.repo}#${briefed.number}`, headSha: briefed.headSha } : undefined;
  useSeenAfter(
    record && seenPr && shown?.anchor ? `${seenPr.headSha}|${shown.key}` : undefined,
    () => onScreen(heading.current),
    () => {
      if (!record || !seenPr || !shown?.anchor) return;
      record(seenPr.pr, seenPr.headSha, {
        ...(shown.checkId ? { checkId: shown.checkId } : {}),
        path: shown.anchor.path,
        ...(shown.anchor.line !== undefined ? { line: shown.anchor.line } : {}),
        how: "guided",
      });
    },
  );

  if (!active) return <div ref={root}>{children}</div>;

  const current = steps[step] as GuidedStep;
  const extra = step >= core;
  const lastCore = step === core - 1;
  const last = step === steps.length - 1;
  const extras = steps.length - core;
  const target = briefing.target;
  const headSha = diff.state === "ok" ? diff.diff.headSha : target.kind === "pr" ? target.headSha : undefined;
  const fileUrl =
    target.kind === "pr" && headSha
      ? (path: string, line?: number) => blobUrl(target.repo, headSha, path, line)
      : undefined;
  const fileOf = (path: string) => (diff.state === "ok" ? diff.diff.files.find((f) => f.path === path) : undefined);
  const anchor = current.anchor;
  const excerpt = anchor ? excerptAround(fileOf(anchor.path), anchor.line) : undefined;
  const fbItem =
    "eyes" in current.item ? eyesItem(current.item.eyes, briefing.checks) : findingItem(current.item.finding);
  const fromNote = "eyes" in current.item ? current.item.eyes.fromNote : current.item.finding.fromNote;
  // E1, E2… as the brief and the diff number them; the model's extras have no number there.
  const id = extra ? `M${step - core + 1}` : `E${step + 1}`;

  return (
    <div ref={root}>
      <section className="v3-walk" aria-labelledby="guided-title" aria-roledescription="guided review">
        <div className="v3-walk-top">
          <span className="v3-walk-count" aria-live="polite">
            {extra ? `Extra ${step - core + 1} of ${extras} · from the model` : `Step ${step + 1} of ${core}`}
          </span>
          <span className="v3-dots" aria-hidden="true">
            {steps.map((s, i) => (
              <span key={s.key} className={`${i <= step ? "on" : ""}${i >= core ? " extra" : ""}`} />
            ))}
          </span>
          <span className="v3-walk-loc">
            {anchor &&
              (fileUrl ? (
                <a className="place" href={fileUrl(anchor.path, anchor.line)} target="_blank" rel="noreferrer">
                  {where(anchor.path, anchor.line)} ↗
                </a>
              ) : (
                <span className="place">{where(anchor.path, anchor.line)}</span>
              ))}
          </span>
        </div>

        <div className="v3-walk-head">
          <div className="v3-ids">
            <span className="v3-id">{id}</span>
            {current.severity && <span className={`v3-sev ${current.severity}`}>{SEVERITY[current.severity]}</span>}
            {current.checkId && <span className="v3-check-id">{current.checkId}</span>}
            {current.source === "llm" && <span className="v3-check-id">model</span>}
            <button type="button" className="v3-quiet-btn" onClick={leave} aria-keyshortcuts="Escape">
              Back to the brief <kbd>Esc</kbd>
            </button>
          </div>
          <h3 className="v3-walk-why" id="guided-title" tabIndex={-1} ref={heading}>
            {current.title}
          </h3>
          <p className="v3-walk-reason">{current.reason}</p>
          {current.learned && <span className="learned-why">↑ {current.learned}</span>}
          {fromNote && <FromNoteLine note={fromNote} />}
        </div>

        {anchor && target.kind === "pr" && loadDiff && (
          <CodeAt path={anchor.path} excerpt={excerpt} diff={diff} url={fileUrl?.(anchor.path, anchor.line)} />
        )}

        {current.related.length > 0 && (
          <div className="v3-also">
            <h4 className="v3-label">Look at these too</h4>
            <ul className="visually-plain">
              {current.related.map((file) => (
                <RelatedRow
                  key={`${current.key}|${file.path}`}
                  file={file}
                  diffFile={fileOf(file.path)}
                  url={fileUrl?.(file.path, file.line)}
                />
              ))}
            </ul>
          </div>
        )}

        <div className="v3-walk-acts">
          {onComment && anchor && (
            <button
              type="button"
              className="v3-btn"
              title={
                anchor.line === undefined || (diff.state === "ok" && !excerpt)
                  ? "Not in the PR's diff: it goes in the review body, with a link to the code."
                  : undefined
              }
              onClick={() =>
                onComment({
                  path: anchor.path,
                  ...(anchor.line !== undefined ? { line: anchor.line } : {}),
                  side: "RIGHT",
                })
              }
            >
              Comment here
            </button>
          )}
          {feedback && <Verdicts item={fbItem} feedback={feedback} />}
          <nav className="v3-walk-nav" aria-label="Walk-through steps">
            <button
              type="button"
              className="v3-text-btn"
              disabled={step === 0}
              onClick={() => go(step - 1)}
              aria-keyshortcuts="p"
            >
              Previous <kbd>p</kbd>
            </button>
            {!last && lastCore && (
              <button type="button" className="v3-btn" onClick={() => go(step + 1)} aria-keyshortcuts="n">
                Next: {extras} more from the model <kbd>n</kbd>
              </button>
            )}
            {!last && !lastCore && (
              <button type="button" className="v3-primary" onClick={() => go(step + 1)} aria-keyshortcuts="n">
                Next <kbd>n</kbd>
              </button>
            )}
            {(last || lastCore) && (
              <button type="button" className="v3-primary" onClick={finish}>
                {onFinish ? "Finish: review your comments" : "Finish"}
              </button>
            )}
          </nav>
        </div>
        {feedback && fromNote && <NoteOffer key={current.key} item={fbItem} note={fromNote} feedback={feedback} />}
      </section>
    </div>
  );
}

/**
 * A PR's diff for the code at its places, from the same cache as the Diff tab (by PR and the briefing's head commit),
 * so the brief, the walk-through and the diff fetch it once between them. Idle without `loadDiff`.
 */
export function useBriefingDiff(
  briefing: Briefing,
  loadDiff: ((pr: string) => Promise<PrDiff>) | undefined,
): DiffState {
  const [state, setState] = useState<DiffState & { for?: string }>({ state: "idle" });
  const target = briefing.target;
  const pr = target.kind === "pr" ? `${target.repo}#${target.number}` : undefined;
  const headSha = target.kind === "pr" ? target.headSha : undefined;
  const id = pr ? `${pr}@${headSha ?? briefing.generatedAt}` : undefined;
  useEffect(() => {
    if (!loadDiff || !pr || !id) return;
    let live = true;
    setState((s) => (s.for === id && s.state === "ok" ? s : { state: "loading", for: id }));
    cachedDiff((p) => loadDiff(p ?? pr), pr, headSha).then(
      (diff) => {
        if (live) setState({ state: "ok", diff, for: id });
      },
      (error: unknown) => {
        if (live)
          setState({ state: "error", message: error instanceof Error ? error.message : String(error), for: id });
      },
    );
    return () => {
      live = false;
    };
  }, [loadDiff, pr, id, headSha]);
  return state.for === id ? state : { state: "idle" };
}

/** The code at a place: an excerpt when the diff has its line, else why not and a link to it on GitHub. */
export function CodeAt({
  path,
  excerpt,
  diff,
  url,
}: {
  path: string;
  excerpt: ReturnType<typeof excerptAround>;
  diff: DiffState;
  url: string | undefined;
}) {
  if (excerpt) return <CodeExcerpt path={path} excerpt={excerpt} />;
  const link = url && (
    <a href={url} target="_blank" rel="noreferrer">
      Open it on GitHub ↗
    </a>
  );
  if (diff.state === "loading" || diff.state === "idle")
    return (
      <p className="v3-code-note" role="status">
        Loading the code…
      </p>
    );
  if (diff.state === "error")
    return (
      <p className="v3-code-note">
        Couldn't load the diff: {diff.message} {link}
      </p>
    );
  return <p className="v3-code-note">This line isn't in the diff. {link}</p>;
}

/** One related file: open its excerpt when it's in the diff, or go to it on GitHub when it isn't. */
function RelatedRow({
  file,
  diffFile,
  url,
}: {
  file: RelatedFile;
  diffFile: PrDiffFile | undefined;
  url?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const excerpt = file.line !== undefined ? excerptAround(diffFile, file.line) : undefined;
  const text = where(file.path, file.line);
  return (
    <li className="v3-also-row">
      <span className="v3-also-kind">{RELATED_LABEL[file.why]}</span>
      <span className="v3-also-what">
        {excerpt ? (
          <button
            type="button"
            className="link-button place"
            aria-expanded={open}
            aria-controls={open ? id : undefined}
            onClick={() => setOpen((o) => !o)}
          >
            {text} {open ? "▾" : "▸"}
          </button>
        ) : url ? (
          <a className="place" href={url} target="_blank" rel="noreferrer">
            {text} ↗
          </a>
        ) : (
          <span className="place">{text}</span>
        )}
      </span>
      {excerpt && open && (
        <div id={id} className="v3-also-code">
          <CodeExcerpt path={file.path} excerpt={excerpt} />
        </div>
      )}
    </li>
  );
}
