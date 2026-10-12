import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import type { BriefingComments, ReviewDraft } from "../drafts";
import { formatWait, plural } from "../format";
import { isYours, type ReviewThread, replyIn, replyWhere, threadPlace } from "../threads";
import { DraftWithAlden } from "./AldenAssist";
import { DraftText } from "./DraftText";

/*
 * The conversation already on a PR, in the Comments drawer: its review threads, each with a Reply box and a Resolve
 * tick. Both make a reply draft (one per thread) that goes out with your one review when you press Send, never on its
 * own: replies post into the review before it's submitted, and threads are resolved only after.
 */

const messageOf = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

/**
 * Asks the Conversation to open (and focus) one thread's Reply box: the Diff tab's Reply. `show` only brings the thread
 * into view (a PR opened from its news). `n` asks again.
 */
export interface ReplyFocus {
  threadId: string;
  n: number;
  show?: boolean;
}

/** Who wrote a comment in a thread: you, them, or an account that's gone. */
const authorOf = (c: ReviewThread["comments"][number]) => (c.isYou ? "you" : (c.author ?? "a deleted account"));

/** One comment of a thread, as GitHub has it: who, in bold, then what they said. Shown as text, never as HTML. */
function ThreadComment({ comment }: { comment: ReviewThread["comments"][number] }) {
  return (
    <li className="thread-comment">
      <p className="thread-body">
        <b className="thread-author">{authorOf(comment)}</b> {comment.body}
      </p>
    </li>
  );
}

/** "2h ago", from an ISO time. */
const ago = (at: string, now = Date.now()) => `${formatWait(Math.max(0, now - Date.parse(at)) / 3_600_000)} ago`;

/**
 * A thread's state, on the right of its card: resolved, outdated, "replied 2h ago" when someone answered in a thread
 * of yours, or open.
 */
export function threadState(t: ReviewThread, now = Date.now()): { text: string; tone: string } {
  if (t.isResolved) return { text: "resolved", tone: "done" };
  if (t.isOutdated) return { text: "outdated", tone: "warn" };
  const last = t.comments[t.comments.length - 1];
  if (isYours(t) && last && !last.isYou) return { text: `replied ${ago(last.createdAt, now)}`, tone: "new" };
  return { text: "open", tone: "open" };
}

/**
 * A thread: where it is, its comments, and your reply. Reply opens a box (⌘↵ saves, Esc cancels); Resolve, ticked,
 * resolves the thread once your review is sent. Saving an empty reply that doesn't resolve drops the draft.
 */
function ThreadCard(props: { thread: ReviewThread; comments: BriefingComments; focus: ReplyFocus | undefined }) {
  const { thread, comments, focus } = props;
  const draft = replyIn(comments.drafts, thread.id);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** What "Draft with Alden" put in the box, until Undo: saving it counts as an assisted reply. */
  const [assisted, setAssisted] = useState<string>();
  const card = useRef<HTMLLIElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const replyButton = useRef<HTMLButtonElement>(null);
  const where = threadPlace(thread);
  const state = threadState(thread);

  const startWriting = () => {
    setText(draft?.body ?? "");
    setAssisted(undefined);
    setError(undefined);
    setWriting(true);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when asked again
  useEffect(() => {
    if (focus?.threadId !== thread.id) return;
    card.current?.scrollIntoView?.({ block: focus.show ? "center" : "nearest" });
    if (focus.show) card.current?.focus();
    else if (thread.viewerCanReply) startWriting();
  }, [focus]);
  useEffect(() => {
    if (writing) area.current?.focus();
  }, [writing]);

  /** Makes the reply draft say this: added, changed, or (with nothing to say or resolve) dropped. */
  async function save(body: string, resolve: boolean, fromAlden?: { edited: boolean }) {
    setBusy(true);
    setError(undefined);
    const counted = fromAlden && body.trim() ? { assisted: fromAlden } : {};
    try {
      if (!draft) {
        if (body.trim() || resolve) {
          await comments.add({ inReplyTo: thread.id, body, ...(resolve ? { resolve } : {}), ...counted });
        }
      } else if (!body.trim() && !resolve) await comments.remove(draft.id);
      else await comments.edit(draft.id, { body, resolve, ...counted });
      return true;
    } catch (e) {
      setError(messageOf(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const finish = () => {
    setWriting(false);
    requestAnimationFrame(() => replyButton.current?.focus());
  };
  /** Whether the reply being saved is Alden's text, and whether you changed it. */
  const fromAlden = () => (assisted !== undefined ? { edited: text.trim() !== assisted.trim() } : undefined);
  const keys = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save(text.trim(), draft?.resolve === true, fromAlden()).then((ok) => ok && finish());
    } else if (e.key === "Escape") {
      // The drawer closes on Esc; here it only closes the box.
      e.preventDefault();
      e.stopPropagation();
      finish();
    }
  };

  return (
    <li
      ref={card}
      className={`thread tcard${thread.isResolved ? " resolved" : ""}${focus?.show && focus.threadId === thread.id ? " shown" : ""}`}
      tabIndex={-1}
    >
      <div className="tcard-head">
        <span className="tcard-where" title={where}>
          {threadPlace({ ...thread, path: thread.path.split("/").pop() ?? thread.path })} ·{" "}
          {isYours(thread) ? "yours" : "open"}
        </span>
        <span className={`tcard-state ${state.tone}`}>{state.text}</span>
      </div>
      <ul className="visually-plain thread-comments">
        {thread.comments.map((c) => (
          <ThreadComment key={c.id} comment={c} />
        ))}
      </ul>
      {draft && !writing && draft.body.trim() !== "" && (
        <div className="thread-reply-draft">
          <span className="faint small">Your reply · posts with your review</span>
          <DraftText text={draft.body} />
        </div>
      )}
      {writing ? (
        <div className="comment-editor">
          <textarea
            ref={area}
            className="input"
            rows={3}
            maxLength={65_000}
            aria-label={`Reply in the thread on ${where}`}
            placeholder="Write a reply"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={keys}
          />
          <DraftWithAlden
            target={{ threadId: thread.id }}
            text={text}
            onText={(next) => {
              setText(next);
              area.current?.focus();
            }}
            onAssisted={setAssisted}
          />
          <div className="form-actions">
            <button
              type="button"
              className="btn sm primary"
              disabled={busy}
              onClick={async () => {
                if (await save(text.trim(), draft?.resolve === true, fromAlden())) finish();
              }}
            >
              {busy ? "Saving…" : "Save reply"}
            </button>
            <button type="button" className="btn sm quiet" onClick={finish}>
              Cancel
            </button>
            <span className="faint small mono">⌘↵ saves · Esc cancels</span>
          </div>
        </div>
      ) : (
        <div className="draft-acts tcard-acts">
          {thread.viewerCanReply && (
            <button
              ref={replyButton}
              type="button"
              className="tcard-act reply"
              aria-label={`${draft?.body.trim() ? "Edit your reply" : "Reply"} in the thread on ${where}`}
              onClick={startWriting}
            >
              {draft?.body.trim() ? "Edit reply" : "Reply"}
            </button>
          )}
          {draft?.body.trim() && (
            <button
              type="button"
              className="tcard-act"
              disabled={busy}
              aria-label={`Discard your reply in the thread on ${where}`}
              onClick={() => void save("", draft.resolve === true)}
            >
              Discard
            </button>
          )}
          {!thread.isResolved && !thread.startedByYou && (
            <span
              className="small faint thread-resolve"
              title="Alden resolves only threads you started, so you never close someone else's question for them."
            >
              {thread.comments[0]?.author ? `${thread.comments[0].author}'s to resolve` : "Not yours to resolve"}
            </span>
          )}
          {!thread.isResolved && thread.startedByYou && (
            <label
              className="small thread-resolve"
              title={
                thread.viewerCanResolve
                  ? "Resolved after your review is submitted, never before."
                  : "GitHub lets the PR's author and people with write access resolve threads."
              }
            >
              <input
                type="checkbox"
                checked={draft?.resolve === true}
                disabled={busy || !thread.viewerCanResolve}
                onChange={(e) => void save(draft?.body ?? "", e.target.checked)}
              />{" "}
              Resolve when sent
            </label>
          )}
          <a className="tcard-link" href={thread.comments[0]?.url} target="_blank" rel="noreferrer">
            On GitHub ↗
          </a>
        </div>
      )}
      {error && (
        <p className="error-text small" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/**
 * The PR's review threads in the drawer: yours first, open before resolved (resolved ones folded away), each with a
 * Reply box and Resolve. Nothing when the API can't read threads (local changes).
 */
export function Conversation(props: { comments: BriefingComments; focus?: ReplyFocus | undefined }) {
  const { comments, focus } = props;
  const state = comments.threads;
  const [showResolved, setShowResolved] = useState(false);
  const focused = focus && state?.threads.find((t) => t.id === focus.threadId);
  useEffect(() => {
    if (focused?.isResolved) setShowResolved(true);
  }, [focused]);
  if (!state) return null;
  const open = state.threads.filter((t) => !t.isResolved);
  const resolved = state.threads.filter((t) => t.isResolved);
  const card = (t: ReviewThread) => <ThreadCard key={t.id} thread={t} comments={comments} focus={focus} />;
  return (
    <section className="drawer-group conversation" aria-labelledby="drawer-conversation">
      <h3 className="visually-hidden" id="drawer-conversation">
        Conversation{state.threads.length > 0 ? ` · ${open.length} open` : ""}
      </h3>
      {state.error && <p className="banner error">{state.error}</p>}
      {state.threads.length === 0 ? (
        !state.error && (
          <p className="faint small">{state.loading ? "Reading the PR's conversation…" : "No review threads yet."}</p>
        )
      ) : (
        <>
          <p className="faint small">Replies and resolves go with your review when you send it, never on their own.</p>
          {open.length > 0 && <ul className="visually-plain tcards">{open.map(card)}</ul>}
          {resolved.length > 0 && (
            <>
              <button
                type="button"
                className="link-button small"
                aria-expanded={showResolved}
                onClick={() => setShowResolved((s) => !s)}
              >
                {showResolved ? "Hide" : "Show"} {plural(resolved.length, "resolved thread")}
              </button>
              {showResolved && <ul className="visually-plain tcards">{resolved.map(card)}</ul>}
            </>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Where each reply will post, for the drawer's list and the summary before Send: "Reply in thread on src/pay.ts:40,
 * and resolve it", with its text.
 */
export function ReplySummary(props: { drafts: ReviewDraft[]; threads: ReviewThread[] | undefined; heading: string }) {
  const replies = props.drafts.filter((d) => d.inReplyTo !== undefined);
  if (replies.length === 0) return null;
  return (
    <section className="drawer-group" aria-labelledby="drafts-in-threads">
      <h3 className="label" id="drafts-in-threads">
        {props.heading} · {replies.length}
      </h3>
      <ul className="visually-plain card drafts">
        {replies.map((d) => (
          <li key={d.id} className="draft">
            <span className="draft-where">
              {replyWhere(
                d,
                props.threads?.find((t) => t.id === d.inReplyTo),
              )}
            </span>
            {d.body.trim() && <DraftText text={d.body} />}
          </li>
        ))}
      </ul>
      {replies.some((d) => d.resolve) && (
        <p className="faint small">Threads are resolved after the review is submitted, never before.</p>
      )}
    </section>
  );
}
