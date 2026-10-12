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
} from "react";
import type { Api, ReviewRequest } from "../api";
import { cachedDiff } from "../diff";
import { type BriefingComments, type CommentPlace, useDrawerOpen } from "../drafts";
import type { BriefingFeedback } from "../feedback";
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

  return { open, close, toggle, editing, setEditing, focus, returnFocus, toggleButton, actions };
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

/** The briefing and its Diff tab: d switches between them, and a place's file:line in the briefing opens the diff there. */
function BriefingTabs(props: {
  briefing: Briefing;
  loadDiff: (pr?: string, since?: string) => Promise<PrDiff>;
  reviewedHead?: string | undefined;
  onComment?: ((place: CommentPlace) => void) | undefined;
  comments?: BriefingComments | undefined;
  children: ReactNode;
}) {
  const { briefing } = props;
  const [tab, setTab] = useBriefingTab();
  const id = useId();
  // The Diff tab loads the first time it's opened, then stays, so switching back is instant.
  const [diffSeen, setDiffSeen] = useState(tab === "diff");
  const [focus, setFocus] = useState<{ path: string; line?: number | undefined }>();
  const choose = useCallback(
    (next: BriefingTab) => {
      if (next === "diff") setDiffSeen(true);
      setTab(next);
    },
    [setTab],
  );
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "d" || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      event.preventDefault();
      choose(tab === "diff" ? "briefing" : "diff");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, choose]);
  const showInDiff = useCallback(
    (place: { path: string; line?: number | undefined }) => {
      choose("diff");
      setFocus({ ...place });
    },
    [choose],
  );

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
  const onTabKey = (event: ReactKeyboardEvent) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const next = tab === "diff" ? "briefing" : "diff";
      choose(next);
      document.getElementById(`${id}tab-${next}`)?.focus();
      event.preventDefault();
    }
  };

  return (
    <>
      <div className="pane-tabs" role="tablist" aria-label="Briefing or diff" onKeyDown={onTabKey}>
        <button
          type="button"
          role="tab"
          id={`${id}tab-briefing`}
          aria-selected={tab === "briefing"}
          aria-controls={`${id}panel-briefing`}
          tabIndex={tab === "briefing" ? 0 : -1}
          onClick={() => choose("briefing")}
        >
          Briefing
        </button>
        <button
          type="button"
          role="tab"
          id={`${id}tab-diff`}
          aria-selected={tab === "diff"}
          aria-controls={`${id}panel-diff`}
          tabIndex={tab === "diff" ? 0 : -1}
          onClick={() => choose("diff")}
        >
          Diff <kbd>D</kbd>
        </button>
      </div>
      <div
        role="tabpanel"
        id={`${id}panel-briefing`}
        aria-labelledby={`${id}tab-briefing`}
        hidden={tab !== "briefing"}
        className="briefing-panel"
      >
        <ShowInDiffContext.Provider value={showInDiff}>{props.children}</ShowInDiffContext.Provider>
      </div>
      {diffSeen && (
        <div
          role="tabpanel"
          id={`${id}panel-diff`}
          aria-labelledby={`${id}tab-diff`}
          hidden={tab !== "diff"}
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
              focus={focus}
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
  const drawerDiff = useDrawerDiff(
    run?.running ? undefined : run?.briefing,
    props.loadDiff ?? props.guided?.loadDiff,
    drawer.editing !== undefined && drawer.editing.kind !== "note",
  );
  const count = comments && !comments.loading ? comments.drafts.length : 0;
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

  const pane = (
    <ReviewActionsContext.Provider value={drawer.actions}>
      <div className={`review-pane${comments && drawer.open ? " drawer-open" : ""}`}>
        <section className="review-main" aria-labelledby="review-title">
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
            {run?.briefing && !run.running && run.briefing.target.kind === "pr" && (
              <BriefingAge
                briefing={run.briefing}
                check={props.freshness}
                onRebrief={() => props.onStart(props.request)}
              />
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
            {run?.briefing && !run.running && props.exportWith && (
              <ExportMenu briefing={run.briefing} {...props.exportWith} />
            )}
            {comments && (
              <button
                ref={drawer.toggleButton}
                type="button"
                className={`btn drawer-toggle${drawer.open ? " on neutral" : ""}`}
                aria-expanded={drawer.open}
                aria-controls="comments-drawer"
                aria-keyshortcuts="s"
                title={drawer.open ? "Hide your comments  s" : "Show your comments  s"}
                onClick={drawer.toggle}
              >
                {count > 0 ? `Comments · ${count}` : "Comments"} <kbd>S</kbd>
              </button>
            )}
            {comments && !run?.running && <DraftMyReview from="toolbar" />}
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
          {run?.briefing && !run.running && run.prepared && (
            <div className="notice note-box">
              <span className="q" aria-hidden="true">
                ✓
              </span>
              <span className="text">
                Prepared while you were away, at{" "}
                {new Date(run.prepared).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                {run.briefing.llm?.status === "ok" ? ", with the model" : ", checks only"}. Brief again for a fresh one.
              </span>
            </div>
          )}
          {run?.briefing &&
            !run.running &&
            (props.loadDiff ? (
              <BriefingTabs
                briefing={run.briefing}
                loadDiff={props.loadDiff}
                reviewedHead={props.reviewedHead}
                onComment={drawer.actions?.onComment}
                comments={props.comments}
              >
                <BriefingView
                  briefing={run.briefing}
                  feedback={props.feedbackFor?.(run.briefing)}
                  perReviewUsd={props.perReviewUsd}
                  comments={props.comments}
                  guided={props.guided}
                />
              </BriefingTabs>
            ) : (
              <BriefingView
                briefing={run.briefing}
                feedback={props.feedbackFor?.(run.briefing)}
                perReviewUsd={props.perReviewUsd}
                comments={props.comments}
                guided={props.guided}
              />
            ))}
          {!run && (
            <p className="muted" style={{ padding: "28px 32px", maxWidth: 640 }}>
              {props.emptyHint}
            </p>
          )}
          {props.children}
        </section>
        {comments && (
          <CommentsDrawer
            comments={comments}
            files={files}
            open={drawer.open}
            onClose={drawer.close}
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
