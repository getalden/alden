import type { Anchor, Briefing } from "@alden/schema";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import {
  type BriefingComments,
  cannotSend,
  groupDrafts,
  placeText,
  type ReviewDraft,
  type ReviewEvent,
  reviewBody,
  type SendReviewResult,
} from "../drafts";
import { plural } from "../format";
import { Segmented } from "./Segmented";

/** What's being written: a comment on a place in the briefing, on any line, or a general note. */
export type Editing =
  | { kind: "place"; key: string }
  | {
      kind: "line";
      initial?: { path?: string | undefined; line?: number | undefined; body: string };
      replaces?: string;
    }
  | { kind: "note"; initial?: string | undefined; replaces?: string };

/** Keys never fire while you type. */
export const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName));

const messageOf = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

const VERDICTS: { event: ReviewEvent; label: string; past: string }[] = [
  { event: "COMMENT", label: "Comment", past: "commented" },
  { event: "APPROVE", label: "Approve", past: "approved" },
  { event: "REQUEST_CHANGES", label: "Request changes", past: "requested changes" },
];
const verdictOf = (event: ReviewEvent) =>
  VERDICTS.find((v) => v.event === event) ?? (VERDICTS[0] as (typeof VERDICTS)[0]);

const onPlace = (d: ReviewDraft, a: Anchor) => d.path === a.path && d.line === a.line;

/**
 * A textarea with Save and Cancel. Focus moves into it when it opens; ⌘↵ or Ctrl+↵ saves, Esc cancels. A failed save
 * keeps the text and says why.
 */
export function CommentEditor(props: {
  label: string;
  initial?: string | undefined;
  saveLabel?: string;
  /** Fields above the text (file and line); the first of them takes focus instead of the text. */
  fields?: ReactNode;
  firstField?: RefObject<HTMLElement | null>;
  /** Why it can't be saved yet, checked on Save. */
  validate?: () => string | undefined;
  onSave: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(props.initial ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const area = useRef<HTMLTextAreaElement>(null);
  const { firstField } = props;
  useEffect(() => {
    (firstField?.current ?? area.current)?.focus();
  }, [firstField]);

  async function save() {
    if (!text.trim() || saving) return;
    const invalid = props.validate?.();
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await props.onSave(text.trim());
    } catch (e) {
      setError(messageOf(e));
      setSaving(false);
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc anywhere in the editor cancels it
    <div
      className="comment-editor"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          e.preventDefault();
          props.onCancel();
        }
      }}
    >
      {props.fields}
      <textarea
        ref={area}
        className="input"
        aria-label={props.label}
        placeholder="Write a comment"
        rows={3}
        maxLength={65_000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
        }}
      />
      {error && (
        <p className="error-text small" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="btn sm primary" disabled={saving || !text.trim()} onClick={save}>
          {saving ? "Saving…" : (props.saveLabel ?? "Save")}
        </button>
        <button type="button" className="btn sm quiet" onClick={props.onCancel}>
          Cancel
        </button>
        <span className="faint small mono">⌘↵ saves · Esc cancels</span>
      </div>
    </div>
  );
}

/** "from Claude" on drafts Claude Code added, so you read them before they go out under your name. */
function Source({ draft }: { draft: ReviewDraft }) {
  return draft.source === "claude" ? <span className="chip from-claude">from Claude</span> : null;
}

/**
 * A place in the briefing you can comment on: its drafts, a Comment button, and the editor when open. Closing the
 * editor puts focus back on the button.
 */
export function CommentSlot(props: {
  anchor: Anchor & { line: number };
  comments: BriefingComments;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  compact?: boolean;
}) {
  const { anchor, comments, open } = props;
  const button = useRef<HTMLButtonElement>(null);
  const restore = useRef(false);
  useEffect(() => {
    if (!open && restore.current) {
      restore.current = false;
      button.current?.focus();
    }
  }, [open]);
  const close = () => {
    restore.current = true;
    props.onClose();
  };
  const here = comments.drafts.filter((d) => onPlace(d, anchor));
  const where = placeText(anchor);
  return (
    <div className={`comment-slot${props.compact ? " compact" : ""}`}>
      {here.length > 0 && (
        <ul className="drafts-here visually-plain" aria-label={`Your comments on ${where}`}>
          {here.map((d) => (
            <li key={d.id}>
              <span className="faint mono">{d.state === "outdated" ? "outdated draft" : "draft"}</span>
              <Source draft={d} />
              <span className="body">{d.body}</span>
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <CommentEditor
          label={`Comment on ${where}`}
          onCancel={close}
          onSave={async (body) => {
            await comments.add({ path: anchor.path, line: anchor.line, side: "RIGHT", body });
            close();
          }}
        />
      ) : (
        <button
          ref={button}
          type="button"
          className={props.compact ? "link-button small" : "btn xs"}
          aria-label={`Comment on ${where}`}
          onClick={props.onOpen}
        >
          Comment
        </button>
      )}
    </div>
  );
}

/** Any line of a changed file: pick the file and the line, then write. */
function LineForm(props: {
  files: Briefing["files"];
  initial?: { path?: string | undefined; line?: number | undefined; body: string } | undefined;
  onSave: (draft: { path: string; line: number; side: "RIGHT" | "LEFT"; body: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [path, setPath] = useState(props.initial?.path ?? props.files[0]?.path ?? "");
  const [line, setLine] = useState(props.initial?.line ? String(props.initial.line) : "");
  const select = useRef<HTMLSelectElement>(null);
  const lineNumber = Number(line);
  const file = props.files.find((f) => f.path === path);
  return (
    <CommentEditor
      label="Comment"
      initial={props.initial?.body}
      firstField={select}
      validate={() =>
        !path ? "Pick a file." : !Number.isInteger(lineNumber) || lineNumber < 1 ? "Give a line number." : undefined
      }
      fields={
        <div className="line-fields">
          <label className="field">
            File
            <select ref={select} className="input mono" value={path} onChange={(e) => setPath(e.target.value)}>
              {props.files.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.path}
                  {f.status === "removed" ? " (removed)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Line
            <input
              className="input mono"
              inputMode="numeric"
              value={line}
              onChange={(e) => setLine(e.target.value.replace(/\D/g, ""))}
            />
          </label>
        </div>
      }
      onCancel={props.onCancel}
      onSave={(body) =>
        props.onSave({ path, line: lineNumber, side: file?.status === "removed" ? "LEFT" : "RIGHT", body })
      }
    />
  );
}

/** One draft in the Review panel: where, who wrote it, the text; Edit, Delete, and Rewrite when it's outdated. */
function DraftRow(props: {
  draft: ReviewDraft;
  comments: BriefingComments;
  onRewrite: () => void;
  onDeleted: () => void;
}) {
  const { draft, comments } = props;
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const restore = useRef(false);
  useEffect(() => {
    if (!editing && restore.current) {
      restore.current = false;
      editButton.current?.focus();
    }
  }, [editing]);
  useEffect(() => {
    if (confirming) keepButton.current?.focus();
  }, [confirming]);
  const stopEditing = () => {
    restore.current = true;
    setEditing(false);
  };
  const where = placeText(draft) || "general note";
  const outdated = draft.state === "outdated";
  return (
    <li className={`draft${outdated ? " outdated" : ""}`}>
      <div className="draft-head">
        {/* Under its file's heading, so the line is enough. */}
        {draft.path ? (
          <span className="place">{draft.line ? `line ${draft.line}` : "whole file"}</span>
        ) : (
          <span className="faint small">General note</span>
        )}
        <Source draft={draft} />
        {outdated && <span className="pill warn">Outdated</span>}
      </div>
      {editing ? (
        <CommentEditor
          label={`Edit comment on ${where}`}
          initial={draft.body}
          onCancel={stopEditing}
          onSave={async (body) => {
            await comments.edit(draft.id, body);
            stopEditing();
          }}
        />
      ) : (
        <p className="draft-body">{draft.body}</p>
      )}
      {outdated && !editing && (
        <p className="small muted">
          The PR has new commits since this was written, so {draft.path ? "the line may have moved" : "it may not fit"}.
          Check it, then rewrite it on the current code, or delete it.
        </p>
      )}
      {!editing && (
        <div className="draft-acts">
          {confirming ? (
            <>
              <span className="small">Delete this comment?</span>
              <button
                type="button"
                className="btn xs"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await comments.remove(draft.id);
                    props.onDeleted();
                  } catch {
                    setBusy(false);
                    setConfirming(false);
                  }
                }}
              >
                Delete
              </button>
              <button ref={keepButton} type="button" className="btn xs quiet" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </>
          ) : (
            <>
              {outdated ? (
                <button type="button" className="btn xs" onClick={props.onRewrite}>
                  Rewrite
                </button>
              ) : (
                <button
                  ref={editButton}
                  type="button"
                  className="btn xs"
                  aria-label={`Edit comment on ${where}`}
                  onClick={() => setEditing(true)}
                >
                  Edit
                </button>
              )}
              <button
                type="button"
                className="btn xs quiet"
                aria-label={`Delete comment on ${where}`}
                onClick={() => setConfirming(true)}
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** Exactly what will post: the PR, the verdict, the body, each comment. Before Approve, the places left uncommented. */
function Confirm(props: {
  comments: BriefingComments;
  files: string[];
  onBack: () => void;
  onSent: (result: SendReviewResult) => void;
}) {
  const { comments } = props;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const body = reviewBody(comments.body, comments.drafts);
  const inline = comments.drafts.filter((d) => d.path);
  const blocked = cannotSend(comments.event, comments.body, comments.drafts);
  const verdict = verdictOf(comments.event);

  async function send() {
    setSending(true);
    setError(undefined);
    try {
      props.onSent(await comments.send());
    } catch (e) {
      setError(messageOf(e));
      setSending(false);
    }
  }

  return (
    <section
      className="card confirm"
      aria-labelledby="confirm-title"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !sending) {
          e.stopPropagation();
          props.onBack();
        }
      }}
    >
      <h3 className="h3" id="confirm-title" ref={heading} tabIndex={-1}>
        Send this review to {comments.pr}?
      </h3>
      <p className="muted small">
        It posts on GitHub under your name, as one review: <strong>{verdict.label}</strong>
        {inline.length > 0 ? `, with ${plural(inline.length, "comment")} on lines` : ""}.
      </p>
      {comments.event === "APPROVE" && comments.unaddressed.length > 0 && (
        <div className="banner">
          <strong>Alden flagged {plural(comments.unaddressed.length, "place")} you didn't comment on.</strong> Approve
          anyway, or go back and look.
          <ul className="unaddressed">
            {comments.unaddressed.map((u) => (
              <li key={`${u.checkId}${placeText(u)}`}>
                {u.path && <span className="place">{placeText(u)}</span>} {u.title}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="section" style={{ gap: 6 }}>
        <h4 className="label">Review body</h4>
        {body ? <p className="draft-body">{body}</p> : <p className="faint small">No body.</p>}
      </div>
      {inline.length > 0 && (
        <div className="section" style={{ gap: 6 }}>
          <h4 className="label">Comments · {inline.length}</h4>
          <ul className="visually-plain confirm-list">
            {groupDrafts(inline, props.files).flatMap((g) =>
              g.drafts.map((d) => (
                <li key={d.id}>
                  <span className="draft-head">
                    <span className="place">{placeText(d)}</span>
                    <Source draft={d} />
                  </span>
                  <p className="draft-body">{d.body}</p>
                </li>
              )),
            )}
          </ul>
        </div>
      )}
      {(error ?? blocked) && (
        <p className="banner error" role="alert">
          {error ?? blocked}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="btn primary" disabled={sending || !!blocked} onClick={send}>
          {sending ? "Sending…" : comments.event === "COMMENT" ? "Send to GitHub" : `${verdict.label} on GitHub`}
        </button>
        <button type="button" className="btn quiet" disabled={sending} onClick={props.onBack}>
          Back
        </button>
      </div>
    </section>
  );
}

/**
 * The review you're writing: your drafts by file, the review's body, the verdict, and one Send. Nothing posts until
 * you've seen the summary and pressed Send there.
 */
export function ReviewPanel(props: {
  briefing: Briefing;
  comments: BriefingComments;
  editing: Editing | undefined;
  onEditing: (editing: Editing | undefined) => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const { briefing, comments, editing, onEditing } = props;
  const [confirming, setConfirming] = useState(false);
  const [sent, setSent] = useState<SendReviewResult>();
  const [checking, setChecking] = useState(false);
  const lineButton = useRef<HTMLButtonElement>(null);
  const noteButton = useRef<HTMLButtonElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const sentLine = useRef<HTMLParagraphElement>(null);
  const restore = useRef<RefObject<HTMLElement | null> | undefined>(undefined);
  const formOpen = editing?.kind === "line" || editing?.kind === "note";
  useEffect(() => {
    if (!formOpen && restore.current) {
      restore.current.current?.focus();
      restore.current = undefined;
    }
  });
  useEffect(() => {
    if (sent) sentLine.current?.focus();
  }, [sent]);
  // The next review has begun.
  const hasDrafts = comments.drafts.length > 0;
  useEffect(() => {
    if (hasDrafts) setSent(undefined);
  }, [hasDrafts]);
  // Starting a comment (c) leaves the summary: it would no longer be what posts.
  useEffect(() => {
    if (formOpen) setConfirming(false);
  }, [formOpen]);
  // A new PR starts a new review.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the PR changes
  useEffect(() => {
    setConfirming(false);
    setSent(undefined);
  }, [comments.pr]);

  const files = briefing.files.map((f) => f.path);
  const groups = groupDrafts(comments.drafts, files);
  const count = comments.drafts.length;
  const blocked = cannotSend(comments.event, comments.body, comments.drafts);
  const closeForm = (back: RefObject<HTMLElement | null>) => {
    restore.current = back;
    onEditing(undefined);
  };

  return (
    <section className="section review-panel" aria-labelledby="review-panel-title">
      <div className="section-head">
        <h2 className="h2" id="review-panel-title" ref={props.headingRef} tabIndex={-1}>
          Review
        </h2>
        <span className="faint small mono">c comment · s review</span>
      </div>
      <p className="muted small">
        Comments stay on this machine until you send them. Nothing reaches GitHub until you press Send and confirm.
      </p>
      {sent && (
        <p className="banner ok" role="status" tabIndex={-1} ref={sentLine}>
          <strong>Sent to GitHub.</strong> You {verdictOf(sent.review).past}
          {sent.posted > 0 ? ` with ${plural(sent.posted, "comment")}` : ""}.{" "}
          <a href={sent.url} target="_blank" rel="noreferrer">
            See the review ↗
          </a>
        </p>
      )}
      {comments.error && <p className="banner error">{comments.error}</p>}

      {confirming ? (
        <Confirm
          comments={comments}
          files={files}
          onBack={() => {
            restore.current = sendButton;
            setConfirming(false);
          }}
          onSent={(result) => {
            setConfirming(false);
            setSent(result);
          }}
        />
      ) : (
        <>
          {count === 0 ? (
            <p className="faint small">
              {comments.loading
                ? "Reading your drafts…"
                : "No comments yet. Comment on a place above, on any line, or add a general note."}
            </p>
          ) : (
            <div className="card drafts">
              {groups.map((g) => (
                <section key={g.path} className="draft-group" aria-label={g.path || "General notes"}>
                  <h3 className="draft-file mono">{g.path || "General notes"}</h3>
                  <ul className="visually-plain">
                    {g.drafts.map((d) => (
                      <DraftRow
                        key={d.id}
                        draft={d}
                        comments={comments}
                        onDeleted={() => props.headingRef.current?.focus()}
                        onRewrite={() =>
                          onEditing(
                            d.path
                              ? { kind: "line", initial: { path: d.path, line: d.line, body: d.body }, replaces: d.id }
                              : { kind: "note", initial: d.body, replaces: d.id },
                          )
                        }
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}

          {editing?.kind === "line" && (
            <div className="card comment-form">
              <h3 className="label">{editing.replaces ? "Rewrite on the current code" : "Comment on a line"}</h3>
              <LineForm
                files={briefing.files}
                initial={editing.initial}
                onCancel={() => closeForm(lineButton)}
                onSave={async (draft) => {
                  await comments.add(draft);
                  if (editing.replaces) await comments.remove(editing.replaces);
                  closeForm(lineButton);
                }}
              />
            </div>
          )}
          {editing?.kind === "note" && (
            <div className="card comment-form">
              <h3 className="label">General note</h3>
              <CommentEditor
                label="General note"
                initial={editing.initial}
                onCancel={() => closeForm(noteButton)}
                onSave={async (body) => {
                  await comments.add({ body });
                  if (editing.replaces) await comments.remove(editing.replaces);
                  closeForm(noteButton);
                }}
              />
            </div>
          )}
          {!formOpen && (
            <div className="form-actions">
              <button
                ref={lineButton}
                type="button"
                className="btn sm"
                onClick={() => {
                  setSent(undefined);
                  onEditing({ kind: "line" });
                }}
              >
                Comment on a line…
              </button>
              <button
                ref={noteButton}
                type="button"
                className="btn sm"
                onClick={() => {
                  setSent(undefined);
                  onEditing({ kind: "note" });
                }}
              >
                Add a general note
              </button>
            </div>
          )}

          <label className="field">
            Review body
            <textarea
              className="input"
              rows={3}
              placeholder="Optional. Your general notes are added after it."
              value={comments.body}
              onChange={(e) => comments.setBody(e.target.value)}
            />
          </label>
          <div className="send-row">
            <Segmented label="Verdict">
              {VERDICTS.map((v) => (
                <button
                  key={v.event}
                  type="button"
                  aria-pressed={comments.event === v.event}
                  onClick={() => comments.setEvent(v.event)}
                >
                  {v.label}
                </button>
              ))}
            </Segmented>
            <button
              ref={sendButton}
              type="button"
              className="btn primary"
              disabled={!!blocked || comments.loading || checking || formOpen}
              onClick={async () => {
                // Read the drafts once more, so the summary has anything Claude Code added since.
                setChecking(true);
                await comments.reload();
                setChecking(false);
                setSent(undefined);
                setConfirming(true);
              }}
            >
              {count > 0 ? `Send review · ${plural(count, "comment")}` : "Send review"}
            </button>
          </div>
          {blocked && count + comments.body.trim().length > 0 && <p className="faint small">{blocked}</p>}
        </>
      )}
    </section>
  );
}
