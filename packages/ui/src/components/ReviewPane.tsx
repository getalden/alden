import type { Briefing, BriefingFreshness, BriefingTarget, PrDiff } from "@alden/schema";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Api, ReviewRequest } from "../api";
import { cachedDiff } from "../diff";
import { type BriefingComments, type CommentPlace, useDrawerOpen } from "../drafts";
import type { BriefingFeedback } from "../feedback";
import { guidedKey, guidedSteps, savedProgress, subscribeProgress } from "../guided";
import { useActiveTime } from "../review-time";
import type { ReviewRun } from "../reviews";
import { onLinkClick } from "../router";
import { AldenAssistContext, DraftMyReview, useAssist } from "./AldenAssist";
import { BriefingAge } from "./BriefingAge";
import { BriefingView } from "./BriefingView";
import {
  CommentsDrawer,
  type DrawerFocus,
  type Editing,
  placeFromElement,
  type ReviewActions,
  ReviewActionsContext,
  typing,
} from "./Comments";
import { DiffThreadsProvider } from "./DiffThreads";
import { DiffPane, type DiffPlace, ShowInDiffContext } from "./DiffView";
import { ExportMenu } from "./ExportMenu";
import type { GuidedReviewProps } from "./GuidedReview";
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
  /** The mono line above the title: "repo #n · author → base · N files · +a −d". */
  crumbs: ReactNode;
  title: string;
  run: ReviewRun | undefined;
  /** The end of the age line, before Export: the model line, which opens the Tune popover. */
  controls?: ReactNode;
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
  /** This PR's drafts, for Comment from Alden. */
  comments?: BriefingComments | undefined;
  /** Whether a PR briefing still matches its PR on GitHub, for "Briefed 30 min ago · main has 4 new commits since". */
  freshness?: ((target: BriefingTarget) => Promise<BriefingFreshness>) | undefined;
  /** Export (copy, save, print) the briefing; `desktop` saves to Downloads through the server. */
  exportWith?: { api: Pick<Api, "briefingMarkdown" | "saveBriefing">; desktop: boolean } | undefined;
  /**
   * More of the PR under the briefing (the diff, the guided review). Inside the pane, `useReviewActions()` gives them
   * `onComment` and `onFinish`.
   */
  children?: ReactNode;
  /** Guided review: the PR's diff for its code excerpts. */
  guided?: Pick<GuidedReviewProps, "loadDiff"> | undefined;
  /** Fetches the diff for the Diff tab (`Api.diff`). Without it there's no Diff tab, only the briefing. */
  loadDiff?: ((pr?: string, since?: string) => Promise<PrDiff>) | undefined;
  /** The head commit you last reviewed, on a PR you reviewed before: the Diff tab offers the changes since. */
  reviewedHead?: string | undefined;
  /**
   * Drafting with Alden on a PR: "Draft my review" and "Draft with Alden" (`model`: one is set up; without one, the
   * drawer offers `onSetUpModel`).
   */
  assist?: { api: Pick<Api, "draftReview" | "suggestText">; model: boolean; onSetUpModel?: () => void } | undefined;
  /** Opens the Comments drawer's Conversation on this thread (a PR opened from its news); `n` asks again. */
  openThread?: { threadId: string; n: number } | undefined;
}

/**
 * The Comments drawer's state for a PR: open or not (remembered for the window), what's being written, and where focus
 * goes. Gives the review's actions (`onComment`, `onFinish`) to everything inside the pane through context, and wires
 * `s` (toggle the drawer) and `c` (comment on the place you're on). Never while you type.
 */
function useCommentsDrawer(comments: BriefingComments | undefined, hasFiles: boolean) {
  const [open, setOpen] = useDrawerOpen();
  const [editing, setEditing] = useState<Editing>();
  const [focus, setFocus] = useState<DrawerFocus>();
  const returnFocus = useRef<HTMLElement | null>(null);
  const toggleButton = useRef<HTMLButtonElement>(null);
  const opened = useRef(0);
  const enabled = comments !== undefined;
  const pr = comments?.pr;

  // Another PR: nothing half-written carries over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the PR changes
  useEffect(() => setEditing(undefined), [pr]);

  const onComment = useCallback(
    (place: CommentPlace) => {
      const active = document.activeElement;
      returnFocus.current = active instanceof HTMLElement && active !== document.body ? active : null;
      opened.current += 1;
      setOpen(true);
      setEditing({ kind: "place", place, n: opened.current });
    },
    [setOpen],
  );
  const onFinish = useCallback(() => {
    setOpen(true);
    setFocus((f) => ({ to: "finish", n: (f?.n ?? 0) + 1 }));
  }, [setOpen]);
  const onReply = useCallback(
    (threadId: string) => {
      setOpen(true);
      setFocus((f) => ({ to: "reply", threadId, n: (f?.n ?? 0) + 1 }));
    },
    [setOpen],
  );
  /** Opens the drawer on a thread in the Conversation, without starting a reply. */
  const showThread = useCallback(
    (threadId: string) => {
      setOpen(true);
      setFocus((f) => ({ to: "reply", threadId, show: true, n: (f?.n ?? 0) + 1 }));
    },
    [setOpen],
  );
  const actions = useMemo<ReviewActions | undefined>(
    () => (enabled ? { onComment, onFinish, onReply } : undefined),
    [enabled, onComment, onFinish, onReply],
  );

  const close = useCallback(() => {
    const inside = document.activeElement?.closest?.("#comments-drawer");
    setOpen(false);
    if (inside) toggleButton.current?.focus();
  }, [setOpen]);
  const toggle = useCallback(() => {
    if (open) return close();
    setOpen(true);
    setFocus((f) => ({ to: "head", n: (f?.n ?? 0) + 1 }));
  }, [open, close, setOpen]);

  const latest = useRef({ toggle, onComment, hasFiles });
  latest.current = { toggle, onComment, hasFiles };
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      if (event.key === "s") latest.current.toggle();
      else if (event.key === "c") {
        const place = placeFromElement(document.activeElement);
        if (place) latest.current.onComment(place);
        else {
          returnFocus.current = null;
          setOpen(true);
          setEditing(latest.current.hasFiles ? { kind: "line" } : { kind: "note" });
        }
      } else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, setOpen]);

  return { open, close, toggle, editing, setEditing, focus, returnFocus, toggleButton, actions, showThread };
}

export type BriefingTab = "briefing" | "diff";
const TAB_KEY = "alden.briefingTab";

/** Briefing or Diff, remembered for this window (sessionStorage): a new window starts on the briefing. */
function useBriefingTab(): [BriefingTab, (tab: BriefingTab) => void] {
  const [tab, setTab] = useState<BriefingTab>(() => {
    try {
      return window.sessionStorage.getItem(TAB_KEY) === "diff" ? "diff" : "briefing";
    } catch {
      return "briefing";
    }
  });
  const choose = useCallback((next: BriefingTab) => {
    setTab(next);
    try {
      window.sessionStorage.setItem(TAB_KEY, next);
    } catch {
      // Storage can be blocked; the tab then holds for this page only.
    }
  }, []);
  return [tab, choose];
}

/** The three steps of reading a PR, in order: the briefing, one place at a time, then the code. */
export type ReadingStep = "brief" | "walk" | "diff";

/**
 * Guided review keeps its own state and listens for its keys (g starts it, Esc leaves it). Until it takes the step as
 * a prop, the header drives it the way the keyboard does, and hears where it is through `subscribeProgress`.
 */
function pressKey(key: string) {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

/**
 * Where you are in a briefing (Brief, Walk through, Diff) and the way between them. d switches between the briefing
 * and the diff; g walks through (guided review's own key); a place's file:line in the briefing opens the diff there.
 */
function useReadingSteps(briefing: Briefing | undefined) {
  const [tab, setTab] = useBriefingTab();
  // The Diff tab loads the first time it's opened, then stays, so switching back is instant.
  const [diffSeen, setDiffSeen] = useState(tab === "diff");
  const [focus, setFocus] = useState<{ path: string; line?: number | undefined }>();
  const key = briefing ? guidedKey(briefing) : undefined;
  const walking = useSyncExternalStore(subscribeProgress, () => (key ? savedProgress(key).active : false));
  const walkable = useMemo(
    () => (briefing ? briefing.needsYourEyes.length > 0 && guidedSteps(briefing).steps.length > 0 : false),
    [briefing],
  );
  const choose = useCallback(
    (next: BriefingTab) => {
      if (next === "diff") setDiffSeen(true);
      setTab(next);
    },
    [setTab],
  );
  // g pressed on the Diff tab starts the walk on the briefing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the walk starts
  useEffect(() => {
    if (walking && tab === "diff") choose("briefing");
  }, [walking]);
  const enabled = briefing !== undefined;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "d" || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      event.preventDefault();
      choose(tab === "diff" ? "briefing" : "diff");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, tab, choose]);
  const showInDiff = useCallback(
    (place: { path: string; line?: number | undefined }) => {
      choose("diff");
      setFocus({ ...place });
    },
    [choose],
  );
  const step: ReadingStep = tab === "diff" ? "diff" : walking ? "walk" : "brief";
  const go = useCallback(
    (next: ReadingStep) => {
      if (next === "diff") return choose("diff");
      choose("briefing");
      if (next === "walk" && !walking && walkable) pressKey("g");
      if (next === "brief" && walking) pressKey("Escape");
    },
    [choose, walking, walkable],
  );
  return { tab, step, go, walkable, diffSeen, focus, showInDiff };
}

const STEP_LABELS: { step: ReadingStep; n: string; label: string; key?: string }[] = [
  { step: "brief", n: "1", label: "Brief" },
  { step: "walk", n: "2", label: "Walk through", key: "g" },
  { step: "diff", n: "3", label: "Diff", key: "d" },
];

/** "1 Brief · 2 Walk through g · 3 Diff d": the numbered steps of one read, as tabs. */
function ReadingSteps(props: {
  id: string;
  step: ReadingStep;
  onStep: (step: ReadingStep) => void;
  walkable: boolean;
  diff: boolean;
}) {
  const steps = STEP_LABELS.filter((s) => s.step !== "diff" || props.diff);
  const onKey = (event: ReactKeyboardEvent) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const usable = steps.filter((s) => s.step !== "walk" || props.walkable);
    const at = usable.findIndex((s) => s.step === props.step);
    const next = usable[(at + (event.key === "ArrowRight" ? 1 : -1) + usable.length) % usable.length];
    if (!next) return;
    props.onStep(next.step);
    document.getElementById(`${props.id}step-${next.step}`)?.focus();
    event.preventDefault();
  };
  return (
    <div className="steps-control" role="tablist" aria-label="Reading step" onKeyDown={onKey}>
      {steps.map((s) => (
        <button
          key={s.step}
          type="button"
          role="tab"
          id={`${props.id}step-${s.step}`}
          aria-selected={props.step === s.step}
          aria-controls={s.step === "diff" ? `${props.id}panel-diff` : `${props.id}panel-briefing`}
          aria-keyshortcuts={s.key}
          tabIndex={props.step === s.step ? 0 : -1}
          disabled={s.step === "walk" && !props.walkable}
          title={s.step === "walk" && !props.walkable ? "Nothing flagged to walk through" : undefined}
          onClick={() => props.onStep(s.step)}
        >
          <span className="step-n" aria-hidden="true">
            {s.n}
          </span>
          {s.label}
          {s.key && <kbd>{s.key}</kbd>}
        </button>
      ))}
    </div>
  );
}

/** The briefing and its diff, one shown at a time; the header's reading steps choose which. */
function BriefingPanels(props: {
  id: string;
  briefing: Briefing;
  reading: ReturnType<typeof useReadingSteps>;
  loadDiff: (pr?: string, since?: string) => Promise<PrDiff>;
  reviewedHead?: string | undefined;
  onComment?: ((place: CommentPlace) => void) | undefined;
  comments?: BriefingComments | undefined;
  children: ReactNode;
}) {
  const { briefing, reading, id } = props;
  const target = briefing.target;
  const pr = target.kind === "pr" ? `${target.repo}#${target.number}` : undefined;
  const places = useMemo<DiffPlace[]>(
    () =>
      briefing.needsYourEyes.flatMap((item, i) =>
        item.anchor
          ? [{ path: item.anchor.path, line: item.anchor.line, title: item.title, index: i + 1, checkId: item.checkId }]
          : [],
      ),
    [briefing],
  );
  const all = pr && props.comments?.pr.toLowerCase() === pr.toLowerCase() ? props.comments.drafts : undefined;
  // A linked note shows at the code it links to, when the diff has it (or on its file).
  const drafts = useMemo(
    () =>
      all?.map((d) =>
        d.linkTo ? { ...d, path: d.linkTo.path, line: d.linkTo.line, startLine: d.linkTo.startLine, side: "RIGHT" } : d,
      ),
    [all],
  );
  return (
    <>
      <div
        role="tabpanel"
        id={`${id}panel-briefing`}
        aria-labelledby={`${id}step-${reading.step === "walk" ? "walk" : "brief"}`}
        hidden={reading.tab !== "briefing"}
        className="briefing-panel"
      >
        <ShowInDiffContext.Provider value={reading.showInDiff}>{props.children}</ShowInDiffContext.Provider>
      </div>
      {reading.diffSeen && (
        <div
          role="tabpanel"
          id={`${id}panel-diff`}
          aria-labelledby={`${id}step-diff`}
          hidden={reading.tab !== "diff"}
          className="diff-panel"
        >
          <DiffThreadsProvider comments={props.comments} pr={pr}>
            <DiffPane
              load={props.loadDiff}
              since={target.kind === "pr" ? props.reviewedHead : undefined}
              pr={pr}
              headSha={target.kind === "pr" ? target.headSha : undefined}
              prUrl={target.kind === "pr" ? target.url : undefined}
              places={places}
              drafts={drafts}
              focus={reading.focus}
              onComment={props.onComment}
            />
          </DiffThreadsProvider>
        </div>
      )}
    </>
  );
}

/**
 * The PR's diff for the Comments drawer, loaded (from the Diff tab's cache) once you start writing a comment, so the
 * editor can say before you save when a line isn't in it. Undefined until then, and for local changes.
 */
function useDrawerDiff(
  briefing: Briefing | undefined,
  load: ((pr: string) => Promise<PrDiff>) | undefined,
  writing: boolean,
): PrDiff | undefined {
  const target = briefing?.target;
  const pr = target?.kind === "pr" ? `${target.repo}#${target.number}` : undefined;
  const headSha = target?.kind === "pr" ? target.headSha : undefined;
  const key = pr && `${pr}@${headSha ?? briefing?.generatedAt}`;
  const [loaded, setLoaded] = useState<{ key: string; diff: PrDiff }>();
  const has = loaded?.key === key;
  useEffect(() => {
    if (!writing || !load || !pr || !key || has) return;
    let live = true;
    cachedDiff((p) => load(p ?? pr), pr, headSha).then(
      (diff) => {
        if (live) setLoaded({ key, diff });
      },
      () => undefined, // The server decides where the comment goes; the drawer lists it there.
    );
    return () => {
      live = false;
    };
  }, [writing, load, pr, key, headSha, has]);
  return has ? loaded?.diff : undefined;
}

/** A PR (or your local changes) and its briefing: run it, watch it, read it; on a PR, the Comments drawer beside it. */
export function ReviewPane(props: ReviewPaneProps) {
  const { run, comments } = props;
  const files = run?.briefing && !run.running && run.briefing.files.length > 0 ? run.briefing.files : undefined;
  const drawer = useCommentsDrawer(comments, files !== undefined);
  const { showThread } = drawer;
  const enabledDrawer = comments !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when asked again
  useEffect(() => {
    if (props.openThread && enabledDrawer) showThread(props.openThread.threadId);
  }, [props.openThread?.n, props.openThread?.threadId, enabledDrawer]);
  const drawerDiff = useDrawerDiff(
    run?.running ? undefined : run?.briefing,
    props.loadDiff ?? props.guided?.loadDiff,
    drawer.editing !== undefined && drawer.editing.kind !== "note",
  );
  const count = comments && !comments.loading ? comments.drafts.length : 0;
  // Time to review: while a PR's briefing is up, how long this pane is in front of you.
  const briefed = run?.briefing?.target.kind === "pr" ? run.briefing.target : undefined;
  useActiveTime(briefed ? `${briefed.repo}#${briefed.number}` : undefined);
  const assist = useAssist({
    api: props.assist?.api,
    comments,
    briefing: run?.running ? undefined : run?.briefing,
    model: props.assist?.model ?? false,
    onSetUpModel: props.assist?.onSetUpModel,
    // Show the drafts it made.
    onDrafted: () => {
      if (!drawer.open) drawer.toggle();
    },
  });
  useEffect(() => {
    if (!run?.running) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run?.running, props.onCancel]);

  const id = useId();
  const briefing = run?.briefing && !run.running ? run.briefing : undefined;
  const reading = useReadingSteps(briefing);
  const view = briefing ? (
    <BriefingView
      briefing={briefing}
      feedback={props.feedbackFor?.(briefing)}
      perReviewUsd={props.perReviewUsd}
      comments={props.comments}
      guided={props.guided}
    />
  ) : null;

  const pane = (
    <ReviewActionsContext.Provider value={drawer.actions}>
      <div className={`review-pane${comments && drawer.open ? " drawer-open" : ""}`}>
        <section className="review-main" aria-labelledby="review-title">
          <header className="pr-head">
            <div className="pr-meta">
              {props.backToQueue && (
                <a className="back-link" href="/" onClick={onLinkClick({ view: "queue" })}>
                  ← Queue
                </a>
              )}
              {props.crumbs}
            </div>
            <h1 className="pr-title" id="review-title">
              {props.title}
            </h1>
            <div className="pr-actions" role="toolbar" aria-label="Review options">
              {briefing && (
                <ReadingSteps
                  id={id}
                  step={reading.step}
                  onStep={reading.go}
                  walkable={reading.walkable}
                  diff={props.loadDiff !== undefined}
                />
              )}
              <div className="pr-actions-end">
                {comments && (
                  <button
                    ref={drawer.toggleButton}
                    type="button"
                    className={`ghost-btn drawer-toggle${drawer.open ? " on" : ""}`}
                    aria-expanded={drawer.open}
                    aria-controls="comments-drawer"
                    aria-keyshortcuts="s"
                    title={drawer.open ? "Hide your comments  s" : "Show your comments  s"}
                    onClick={drawer.toggle}
                  >
                    Comments
                    {count > 0 && (
                      <>
                        <span className="visually-hidden"> · </span>
                        <span className="count">{count}</span>
                      </>
                    )}{" "}
                    <kbd>S</kbd>
                  </button>
                )}
                {comments && !run?.running && <DraftMyReview from="toolbar" />}
              </div>
            </div>
            <div className="age-line">
              {run?.running ? (
                <span role="status">briefing now…</span>
              ) : briefing ? (
                <>
                  <BriefingAge briefing={briefing} check={props.freshness} />
                  <button
                    type="button"
                    className="age-link"
                    aria-keyshortcuts="b"
                    onClick={() => props.onStart(props.request)}
                  >
                    Brief again <kbd>B</kbd>
                  </button>
                </>
              ) : (
                <>
                  <span>{run?.error ? "the last briefing didn't finish" : "not briefed yet"}</span>
                  <button
                    type="button"
                    className="age-link"
                    aria-keyshortcuts="b"
                    onClick={() => props.onStart(props.request)}
                  >
                    Brief me <kbd>B</kbd>
                  </button>
                </>
              )}
              <span className="age-end">
                {props.controls}
                {briefing && props.exportWith && <ExportMenu briefing={briefing} {...props.exportWith} />}
              </span>
            </div>
          </header>
          <div className="review-scroll">
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
            {briefing && run?.prepared && (
              <div className="notice note-box">
                <span className="q" aria-hidden="true">
                  ✓
                </span>
                <span className="text">
                  Prepared while you were away, at{" "}
                  {new Date(run.prepared).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  {briefing.llm?.status === "ok" ? ", with the model" : ", checks only"}. Brief again for a fresh one.
                </span>
              </div>
            )}
            {briefing &&
              (props.loadDiff ? (
                <BriefingPanels
                  id={id}
                  briefing={briefing}
                  reading={reading}
                  loadDiff={props.loadDiff}
                  reviewedHead={props.reviewedHead}
                  onComment={drawer.actions?.onComment}
                  comments={props.comments}
                >
                  {view}
                </BriefingPanels>
              ) : (
                <div
                  role="tabpanel"
                  id={`${id}panel-briefing`}
                  aria-labelledby={`${id}step-${reading.step === "walk" ? "walk" : "brief"}`}
                  className="briefing-panel"
                >
                  {view}
                </div>
              ))}
            {!run && (
              <div className="brief-empty">
                <p className="muted">{props.emptyHint}</p>
                <button type="button" className="btn primary" onClick={() => props.onStart(props.request)}>
                  Brief me <kbd>B</kbd>
                </button>
              </div>
            )}
            {props.children}
          </div>
        </section>
        {comments && (
          <CommentsDrawer
            comments={comments}
            files={files}
            open={drawer.open}
            onClose={drawer.close}
            onOpen={drawer.toggle}
            editing={drawer.editing}
            onEditing={drawer.setEditing}
            focus={drawer.focus}
            returnFocus={drawer.returnFocus}
            diff={drawerDiff}
          />
        )}
      </div>
    </ReviewActionsContext.Provider>
  );
  return <AldenAssistContext.Provider value={assist}>{pane}</AldenAssistContext.Provider>;
}
