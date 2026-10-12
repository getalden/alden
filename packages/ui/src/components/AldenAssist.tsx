import type { Briefing } from "@alden/schema";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Api, DraftReviewResult, SuggestTextRequest } from "../api";
import type { BriefingComments } from "../drafts";
import { formatUsd, plural } from "../format";

/*
 * Drafting with Alden on demand, when a model is set up:
 * - "Draft my review" (the toolbar and the Comments drawer) asks the model, in one call, for comments on the
 *   briefing's places to look that have no comment near them. They arrive as Alden's drafts, to keep, edit or drop.
 * - "Draft with Alden" (every comment and reply box) asks for one comment's text and puts it in the box. It saves
 *   nothing: what you save is yours. Text you'd already written is what you mean: Alden's version replaces it only
 *   when you choose "Use it", and Undo puts yours back.
 * Neither runs on a PR with text aimed at AI reviewers.
 */

const messageOf = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

/** Why Alden won't draft for a PR whose text talks to AI reviewers: the server's own words. */
export const INJECTED_DRAFTING =
  "Alden won't draft comments for this PR: it has text aimed at AI reviewers (see the check), so nothing the model wrote is offered to send under your name.";

/** What "Draft with Alden" writes for: a line (or lines, or a file), a thread's reply, or a general note. */
export type AssistTarget =
  | { path: string; line?: number | undefined; startLine?: number | undefined; side?: "RIGHT" | "LEFT" | undefined }
  | { threadId: string }
  | { note: true };

type AssistApi = Pick<Api, "draftReview" | "suggestText">;

/** "Draft my review" as its buttons show it: running, what it did, or why it didn't; `from` is the button pressed. */
interface DraftReviewState {
  busy: boolean;
  from?: "toolbar" | "drawer";
  outcome?: string;
  error?: string;
}

/** What the pane gives its comment boxes and buttons about drafting with Alden on this PR. */
export interface AldenAssist {
  pr: string;
  /** A model is set up. */
  model: boolean;
  /** Why Alden won't draft here, or undefined. */
  blocked: string | undefined;
  /** There's a briefing of this PR to draft a review from. */
  briefed: boolean;
  onSetUpModel: (() => void) | undefined;
  suggest(target: AssistTarget, text: string, signal: AbortSignal): Promise<{ text: string; costUsd: number | null }>;
  review: DraftReviewState;
  draftReview(from: "toolbar" | "drawer"): Promise<void>;
}

export const AldenAssistContext = createContext<AldenAssist | undefined>(undefined);

/** Drafting with Alden on this PR, inside ReviewPane; undefined for local changes, or without the API. */
export const useAldenAssist = () => useContext(AldenAssistContext);

const costOf = (usd: number | null) => (usd !== null && usd > 0 ? ` (${formatUsd(usd)})` : "");

/** What "Draft my review" says it did, in a sentence or two. */
export function draftReviewOutcome(result: Pick<DraftReviewResult, "made" | "skipped" | "asked" | "costUsd">): string {
  const skipped =
    result.skipped > 0
      ? ` Skipped ${plural(result.skipped, "place")} with a comment or draft near ${result.skipped === 1 ? "it" : "them"} already.`
      : "";
  if (result.asked === 0) {
    return result.skipped === 0
      ? "Nothing to draft: the briefing has no places to look."
      : "Nothing new to draft: every place to look has a comment or draft near it already.";
  }
  if (result.made === 0) {
    return `The model found nothing worth a comment at those places${costOf(result.costUsd)}.${skipped}`;
  }
  return `Alden drafted ${plural(result.made, "comment")}${costOf(result.costUsd)}: keep, edit or drop each in Comments.${skipped}`;
}

const injected = (briefing: Briefing | undefined) =>
  !!briefing?.checks.some((c) => c.id === "injection.ai" && c.status === "flagged");

/**
 * Drafting with Alden for the PR whose drafts `comments` holds, from its briefing (when there is one). `onDrafted` runs
 * when "Draft my review" made drafts: the pane opens the drawer to show them.
 */
export function useAssist(props: {
  api: AssistApi | undefined;
  comments: BriefingComments | undefined;
  briefing: Briefing | undefined;
  model: boolean;
  onSetUpModel?: (() => void) | undefined;
  onDrafted?: () => void;
}): AldenAssist | undefined {
  const pr = props.comments?.pr;
  const [review, setReview] = useState<DraftReviewState>({ busy: false });
  const current = useRef(pr);
  current.current = pr;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the PR changes
  useEffect(() => setReview({ busy: false }), [pr]);
  const { api, comments, briefing } = props;
  if (!api || !comments || !pr) return undefined;
  const target = briefing?.target;
  const briefed = target?.kind === "pr" && `${target.repo}#${target.number}`.toLowerCase() === pr.toLowerCase();
  return {
    pr,
    model: props.model,
    blocked: briefed && injected(briefing) ? INJECTED_DRAFTING : undefined,
    briefed,
    onSetUpModel: props.onSetUpModel,
    suggest(at, text, signal) {
      const request: SuggestTextRequest = {
        pr,
        ...("threadId" in at ? { threadId: at.threadId } : {}),
        ...("path" in at
          ? {
              path: at.path,
              ...(at.line !== undefined ? { line: at.line } : {}),
              ...(at.line !== undefined && at.startLine !== undefined && at.startLine < at.line
                ? { startLine: at.startLine }
                : {}),
              ...(at.side ? { side: at.side } : {}),
            }
          : {}),
        ...(text.trim() ? { text } : {}),
      };
      return api.suggestText(request, signal);
    },
    review,
    async draftReview(from) {
      if (review.busy) return;
      setReview({ busy: true, from });
      try {
        const result = await api.draftReview(pr);
        if (current.current !== pr) return;
        await comments.reload();
        setReview({ busy: false, from, outcome: draftReviewOutcome(result) });
        if (result.made > 0) props.onDrafted?.();
      } catch (e) {
        if (current.current === pr) setReview({ busy: false, from, error: messageOf(e) });
      }
    },
  };
}

/**
 * "Draft my review": in the briefing's toolbar and the Comments drawer, once the PR has a briefing. One model call,
 * within your caps; it says what it drafted and what that cost, or why it didn't. Without a model, the drawer offers
 * "Set up a model" instead (the toolbar already does).
 */
export function DraftMyReview({ from }: { from: "toolbar" | "drawer" }) {
  const assist = useAldenAssist();
  const [why, setWhy] = useState<string>();
  if (!assist?.briefed) return null;
  if (!assist.model) {
    if (from === "toolbar" || !assist.onSetUpModel) return null;
    return (
      <p className="faint small assist-line">
        Alden can draft your review once a model is set up.{" "}
        <button type="button" className="link-button small" onClick={assist.onSetUpModel}>
          Set up a model
        </button>
      </p>
    );
  }
  const { review } = assist;
  const mine = review.from === from;
  return (
    <>
      <button
        type="button"
        className={from === "toolbar" ? "btn" : "btn sm quiet"}
        aria-disabled={assist.blocked !== undefined || review.busy}
        title="Asks your model, in one call within your caps, to draft comments for the places to look that have none near them. Nothing is sent: you keep, edit or drop each."
        onClick={() => {
          if (assist.blocked) setWhy(assist.blocked);
          else if (!review.busy) void assist.draftReview(from);
        }}
      >
        {review.busy && mine ? "Drafting…" : "Draft my review"}
      </button>
      {why ? (
        <span className="faint small assist-line" role="status">
          {why}
        </span>
      ) : mine && review.busy ? (
        <span className="faint small assist-line" role="status">
          Asking the model about the places to look…
        </span>
      ) : mine && review.error ? (
        <span className="error-text small assist-line" role="alert">
          {review.error}
        </span>
      ) : mine && review.outcome ? (
        <span className="small assist-line" role="status">
          {review.outcome}
        </span>
      ) : null}
    </>
  );
}

type Asking =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "offer"; text: string; previous: string; cost: number | null }
  | { kind: "used"; text: string; previous: string; cost: number | null }
  | { kind: "error"; message: string };

/**
 * "Draft with Alden" under a comment or reply box: asks the model for the text, and puts it in the box for you to edit.
 * An empty box takes it at once (Undo empties it again); text you'd written is kept until you choose "Use it" over it.
 * Cancel stops the request. `onAssisted` hears the text Alden put in the box (undefined after Undo), so saving it can
 * be counted as assisted.
 */
export function DraftWithAlden(props: {
  target: AssistTarget;
  text: string;
  onText: (text: string) => void;
  onAssisted?: (text: string | undefined) => void;
}) {
  const assist = useAldenAssist();
  const [asking, setAsking] = useState<Asking>({ kind: "idle" });
  const stop = useRef<AbortController | undefined>(undefined);
  // Closing the box stops a request still under way.
  useEffect(() => () => stop.current?.abort(), []);
  if (!assist?.model) return null;
  if (assist.blocked) {
    return <p className="faint small assist-line">Alden won't draft here: the PR has text aimed at AI reviewers.</p>;
  }
  const use = (text: string, previous: string, cost: number | null) => {
    props.onText(text);
    props.onAssisted?.(text);
    setAsking({ kind: "used", text, previous, cost });
  };
  const ask = async () => {
    const controller = new AbortController();
    stop.current = controller;
    const previous = props.text;
    setAsking({ kind: "busy" });
    try {
      const answer = await assist.suggest(props.target, previous, controller.signal);
      if (controller.signal.aborted) return;
      if (previous.trim()) setAsking({ kind: "offer", text: answer.text, previous, cost: answer.costUsd });
      else use(answer.text, previous, answer.costUsd);
    } catch (e) {
      if (!controller.signal.aborted) setAsking({ kind: "error", message: messageOf(e) });
    }
  };
  const button = (
    <button
      type="button"
      className="btn xs quiet"
      title={
        props.text.trim()
          ? "Asks your model to make what you've written into a clear comment: one small call, within your caps. You choose whether to use it."
          : "Asks your model for this comment: one small call, within your caps. Nothing is saved or sent until you save it."
      }
      onClick={() => void ask()}
    >
      Draft with Alden
    </button>
  );
  switch (asking.kind) {
    case "busy":
      return (
        <div className="assist">
          <span className="faint small" role="status">
            Drafting with Alden…
          </span>
          <button
            type="button"
            className="btn xs quiet"
            aria-label="Cancel drafting with Alden"
            onClick={() => {
              stop.current?.abort();
              setAsking({ kind: "idle" });
            }}
          >
            Cancel
          </button>
        </div>
      );
    case "offer":
      return (
        <section className="assist-offer" aria-label="Alden's version">
          <p className="faint small">Alden's version{costOf(asking.cost)}. Yours stays until you choose:</p>
          <p className="draft-body">{asking.text}</p>
          <div className="assist">
            <button type="button" className="btn xs" onClick={() => use(asking.text, asking.previous, asking.cost)}>
              Use it
            </button>
            <button type="button" className="btn xs quiet" onClick={() => setAsking({ kind: "idle" })}>
              Keep mine
            </button>
          </div>
        </section>
      );
    case "used":
      return (
        <div className="assist">
          <span className="faint small" role="status">
            Alden's text{costOf(asking.cost)}. Edit it as you like: nothing is saved or sent until you save.
          </span>
          {props.text === asking.text && (
            <button
              type="button"
              className="link-button small"
              onClick={() => {
                props.onText(asking.previous);
                props.onAssisted?.(undefined);
                setAsking({ kind: "idle" });
              }}
            >
              Undo
            </button>
          )}
        </div>
      );
    case "error":
      return (
        <div className="assist">
          {button}
          <span className="error-text small" role="alert">
            {asking.message}
          </span>
        </div>
      );
    default:
      return <div className="assist">{button}</div>;
  }
}
