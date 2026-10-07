import type { Briefing, RelatedFile, Severity } from "@alden/schema";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import type { BriefingFeedback } from "../feedback";
import {
  blobUrl,
  type CommentPlace,
  excerptAround,
  type GuidedStep,
  guidedKey,
  guidedSteps,
  type PrDiff,
  type PrDiffFile,
  RELATED_LABEL,
  savedProgress,
  saveProgress,
} from "../guided";
import { eyesItem, findingItem, Verdicts } from "./BriefingView";
import { CodeExcerpt } from "./CodeExcerpt";
import { typing } from "./Comments";

export interface GuidedReviewProps {
  briefing: Briefing;
  feedback?: BriefingFeedback | undefined;
  /** Fetches a PR's diff ("owner/repo#12") for the code at each step. Absent for local changes: steps name the place. */
  loadDiff?: ((pr: string) => Promise<PrDiff>) | undefined;
  /** Opens a comment on a step's place. Without it, steps have no Comment action. */
  onComment?: ((place: CommentPlace) => void) | undefined;
  /** "Finish: review your comments" on the last step; leaving guided mode happens either way. */
  onFinish?: (() => void) | undefined;
  /** The briefing's own list of places, shown when you're not in guided mode. */
  children?: ReactNode;
}

type DiffState = { state: "idle" | "loading" } | { state: "ok"; diff: PrDiff } | { state: "error"; message: string };

const SEVERITY: Record<Severity, string> = { critical: "critical", high: "high", medium: "med", low: "low", info: "—" };

const where = (path: string, line?: number) => `${path}${line ? `:${line}` : ""}`;

/**
 * Guided review: the places that need your eyes one at a time, in Alden's order, then the model's other findings as
 * extra steps. Each step shows why it's there, the code at the place, and the files to look at too. n and p move,
 * Esc leaves, g starts. Where you are is kept while the app is open.
 */
export function GuidedReview({ briefing, feedback, loadDiff, onComment, onFinish, children }: GuidedReviewProps) {
  const { steps, core } = useMemo(() => guidedSteps(briefing), [briefing]);
  const key = guidedKey(briefing);
  const [saved, setSaved] = useState(() => ({ key, ...savedProgress(key) }));
  // Another PR in the same pane picks up where you left that one.
  const progress = saved.key === key ? saved : { key, ...savedProgress(key) };
  const step = Math.min(progress.step, Math.max(0, steps.length - 1));
  const active = progress.active && steps.length > 0;
  const set = (next: { active: boolean; step: number }) => {
    saveProgress(key, next);
    setSaved({ key, ...next });
  };

  const heading = useRef<HTMLHeadingElement>(null);
  const startButton = useRef<HTMLButtonElement>(null);
  const moved = useRef(false);
  const go = (to: number) => {
    moved.current = true;
    set({ active: true, step: Math.max(0, Math.min(steps.length - 1, to)) });
  };
  const leave = () => {
    moved.current = false;
    set({ active: false, step });
    // Back to where guided mode started from, so the keyboard isn't lost.
    requestAnimationFrame(() => startButton.current?.focus());
  };
  const finish = () => {
    set({ active: false, step: 0 });
    onFinish?.();
  };
  // Focus follows the step: its heading, so a screen reader reads the new title.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the step changes
  useEffect(() => {
    if (!active || !moved.current) return;
    moved.current = false;
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

  const diff = useDiff(briefing, active ? loadDiff : undefined);

  if (steps.length === 0) return <>{children}</>;
  if (!active) {
    return (
      <>
        <div className="guided-start">
          <button ref={startButton} type="button" className="btn sm" aria-keyshortcuts="g" onClick={() => go(step)}>
            {step > 0 ? `Resume guided review at step ${step + 1}` : "Start guided review"} <kbd>G</kbd>
          </button>
          <span className="faint small">One place at a time, with the code and the files to look at too.</span>
        </div>
        {children}
      </>
    );
  }

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

  return (
    <section className="card guided" aria-labelledby="guided-title" aria-roledescription="guided review">
      <div className="guided-head">
        <span className="label" aria-live="polite">
          {extra ? `Extra ${step - core + 1} of ${extras} · from the model` : `Step ${step + 1} of ${core}`}
        </span>
        <span className="guided-bar" aria-hidden="true">
          <span style={{ width: `${((step + 1) / steps.length) * 100}%` }} />
        </span>
        <button type="button" className="btn xs quiet" onClick={leave} aria-keyshortcuts="Escape">
          Leave <kbd>Esc</kbd>
        </button>
      </div>

      <h3 className="h3 guided-title" id="guided-title" tabIndex={-1} ref={heading}>
        {current.title}
      </h3>
      <div className="guided-meta">
        {current.severity && <span className={`sev ${current.severity}`}>{SEVERITY[current.severity]}</span>}
        {current.checkId && <span className="chip mono">{current.checkId}</span>}
        {current.source === "llm" && <span className="chip">model</span>}
        {anchor &&
          (fileUrl ? (
            <a className="place" href={fileUrl(anchor.path, anchor.line)} target="_blank" rel="noreferrer">
              {where(anchor.path, anchor.line)} ↗
            </a>
          ) : (
            <span className="place">{where(anchor.path, anchor.line)}</span>
          ))}
      </div>
      <p className="eye-text">{current.reason}</p>
      {current.learned && <span className="learned-why">↑ {current.learned}</span>}

      {anchor && target.kind === "pr" && loadDiff && (
        <CodeAt path={anchor.path} excerpt={excerpt} diff={diff} url={fileUrl?.(anchor.path, anchor.line)} />
      )}

      {current.related.length > 0 && (
        <div className="guided-related">
          <h4 className="label">Look at these too</h4>
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

      {(feedback || (onComment && anchor?.line)) && (
        <div className="guided-acts">
          {feedback && <Verdicts item={fbItem} feedback={feedback} />}
          {onComment && anchor?.line && (
            <button
              type="button"
              className="btn sm"
              onClick={() => onComment({ path: anchor.path, line: anchor.line as number, side: "RIGHT" })}
            >
              Comment
            </button>
          )}
        </div>
      )}

      <nav className="guided-nav" aria-label="Guided review steps">
        <button
          type="button"
          className="btn sm"
          disabled={step === 0}
          onClick={() => go(step - 1)}
          aria-keyshortcuts="p"
        >
          ← Previous <kbd>P</kbd>
        </button>
        <span className="guided-next">
          {(last || lastCore) && (
            <button type="button" className="btn sm primary" onClick={finish}>
              {onFinish ? "Finish: review your comments" : "Finish"}
            </button>
          )}
          {!last && (
            <button
              type="button"
              className={`btn sm${lastCore ? "" : " primary"}`}
              onClick={() => go(step + 1)}
              aria-keyshortcuts="n"
            >
              {lastCore ? `Next: ${extras} more from the model` : "Next"} <kbd>N</kbd>
            </button>
          )}
        </span>
      </nav>
    </section>
  );
}

/** The PR's diff, fetched once guided mode starts. */
function useDiff(briefing: Briefing, loadDiff: ((pr: string) => Promise<PrDiff>) | undefined): DiffState {
  const [state, setState] = useState<DiffState & { for?: string }>({ state: "idle" });
  const target = briefing.target;
  const pr = target.kind === "pr" ? `${target.repo}#${target.number}` : undefined;
  const id = pr ? `${pr}@${briefing.generatedAt}` : undefined;
  useEffect(() => {
    if (!loadDiff || !pr || !id) return;
    let live = true;
    setState((s) => (s.for === id && s.state === "ok" ? s : { state: "loading", for: id }));
    loadDiff(pr).then(
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
  }, [loadDiff, pr, id]);
  return state.for === id ? state : { state: "idle" };
}

function CodeAt({
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
      <p className="faint small" role="status">
        Loading the code…
      </p>
    );
  if (diff.state === "error")
    return (
      <p className="muted small">
        Couldn't load the diff: {diff.message} {link}
      </p>
    );
  return <p className="muted small">This line isn't in the diff. {link}</p>;
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
    <li className="related">
      <span className="chip">{RELATED_LABEL[file.why]}</span>
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
      {excerpt && open && (
        <div id={id} className="related-code">
          <CodeExcerpt path={file.path} excerpt={excerpt} />
        </div>
      )}
    </li>
  );
}
