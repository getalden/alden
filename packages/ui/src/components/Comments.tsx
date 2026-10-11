import type { Anchor, Briefing, PrDiff } from "@alden/schema";
import { linkLines } from "@alden/schema/note-text";
import {
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { takesInline } from "../diff";
import {
  type BriefingComments,
  type CommentPlace,
  cannotSend,
  groupDrafts,
  linkedTitle,
  type NewDraft,
  placeText,
  type ReviewDraft,
  type ReviewEvent,
  reviewBody,
  type SendReviewResult,
  toSend,
  unkept,
  whereText,
} from "../drafts";
import { plural } from "../format";
import { AldenDraftActs, AldenDraftsBar, AldenLabel } from "./AldenDrafts";
import { Conversation, type ReplyFocus, ReplySummary } from "./Conversation";
import { Segmented } from "./Segmented";

/**
 * What's being written in the Comments drawer: a comment on a place (from the briefing, the diff or the guided review),
 * on a line you pick, or a general note. `replaces` is the outdated draft a rewrite takes the place of; `n` makes a
 * second request for the same place open (and focus) the editor again.
 */
export type Editing =
  | {
      kind: "place";
      place: CommentPlace;
      n: number;
      initial?: { body: string; suggestion?: string | undefined };
      replaces?: string;
    }
  | {
      kind: "line";
      initial?: {
        path?: string | undefined;
        line?: number | undefined;
        startLine?: number | undefined;
        body: string;
        suggestion?: string | undefined;
      };
      replaces?: string;
    }
  | { kind: "note"; initial?: string | undefined; replaces?: string };

/**
 * What a PR's review offers whatever is showing it (the briefing, the diff, the guided review): `onComment` opens the
 * Comments drawer with the editor on that place, focused; `onFinish` opens it at the review body, verdict and Send.
 * Provided by ReviewPane on a PR; absent for your local changes, which have no review to send.
 */
export interface ReviewActions {
  onComment(place: CommentPlace): void;
  onFinish(): void;
  /** Opens the drawer at a review thread's Reply box (by the thread's id): the Diff tab's Reply. */
  onReply?(threadId: string): void;
}

export const ReviewActionsContext = createContext<ReviewActions | undefined>(undefined);

/** The PR's review actions, inside ReviewPane; undefined where there's nothing to comment on. */
export const useReviewActions = () => useContext(ReviewActionsContext);

/**
 * Marks an element as a place to comment on, so `c` comments there while focus is on it or inside it. The diff's lines
 * can use it too.
 */
export const placeAttrs = (place: CommentPlace | undefined): Record<string, string | undefined> =>
  place?.line !== undefined
    ? {
        "data-comment-path": place.path,
        "data-comment-line": String(place.line),
        "data-comment-side": place.side,
        "data-comment-start-line": place.startLine ? String(place.startLine) : undefined,
      }
    : {};

/** The place an element (or one around it) is marked with by `placeAttrs`, if any. */
export function placeFromElement(element: Element | null): CommentPlace | undefined {
  const marked = element?.closest("[data-comment-path][data-comment-line]");
  if (!marked) return undefined;
  const path = marked.getAttribute("data-comment-path") ?? "";
  const line = Number(marked.getAttribute("data-comment-line"));
  const startLine = Number(marked.getAttribute("data-comment-start-line"));
  if (!path || !Number.isInteger(line) || line < 1) return undefined;
  return {
    path,
    line,
    side: marked.getAttribute("data-comment-side") === "LEFT" ? "LEFT" : "RIGHT",
    ...(Number.isInteger(startLine) && startLine > 0 && startLine < line ? { startLine } : {}),
  };
}

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

/** A draft on this place: on its line, or a note linking to it (a whole file's anchor matches a whole-file note). */
const onPlace = (d: ReviewDraft, a: Anchor) => {
  const on = d.linkTo ?? d;
  return on.path === a.path && on.line === a.line;
};

/** "line 4" or "lines 4–9": what a suggestion replaces; "the whole file" without a line. */
const linesText = (p: { line?: number | undefined; startLine?: number | undefined }) =>
  p.line === undefined
    ? "the whole file"
    : p.startLine && p.startLine < p.line
      ? `lines ${p.startLine}–${p.line}`
      : `line ${p.line}`;

/** Leaves out what isn't set, so the request carries only what you wrote. */
const lineDraft = (
  p: { path: string; line?: number | undefined; startLine?: number | undefined; side: "RIGHT" | "LEFT" },
  body: string,
  suggestion: string | undefined,
): NewDraft => ({
  path: p.path,
  ...(p.line !== undefined ? { line: p.line } : {}),
  ...(p.line !== undefined && p.startLine && p.startLine < p.line ? { startLine: p.startLine } : {}),
  side: p.side,
  body,
  ...(suggestion !== undefined ? { suggestion } : {}),
});

/**
 * Whether a comment on this place goes in the review body as a linked note: a whole file always; a line (or lines)
 * when the diff is known and GitHub wouldn't take it inline. Undefined while that can't be told (the server decides).
 * Removed (LEFT) lines outside the diff can't be linked, so they're never a note.
 */
export function goesInBody(
  diff: PrDiff | undefined,
  place: { path: string; line?: number | undefined; startLine?: number | undefined; side?: string | undefined },
): boolean | undefined {
  if (place.line === undefined) return true;
  if (!diff || place.side === "LEFT") return undefined;
  return !takesInline(diff, place);
}

/** What the editor says before you save a comment that goes in the review body, in a sentence. */
export function linkedNotice(place: { line?: number | undefined; startLine?: number | undefined }): string {
  if (place.line === undefined) return "A comment on a whole file goes in the review body, with a link to the file.";
  return place.startLine && place.startLine < place.line
    ? "These lines aren't in the PR's diff, so this goes in the review body with a link to them."
    : "This line isn't in the PR's diff, so it goes in the review body with a link to it.";
}

/** Replacement code for the line(s), offered on the new side only (GitHub applies suggestions there). */
interface Suggest {
  /** "line 4" or "lines 4–9". */
  lines: string;
  /** The line(s) as they are, to start from. */
  lineText?: string | undefined;
  /** A suggestion the draft already has. */
  initial?: string | undefined;
  /** In a note in the review body, where GitHub can't apply it: it posts as code to copy. */
  inBody?: boolean | undefined;
}

/**
 * A textarea with Save and Cancel, and "Suggest a change" where the comment can carry one. Focus moves into it when it
 * opens; ⌘↵ or Ctrl+↵ saves, Esc cancels. A failed save keeps the text and says why.
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
  /** Something to know before saving: where it will post, when that isn't where you'd expect. */
  notice?: string | undefined;
  suggest?: Suggest | undefined;
  onSave: (body: string, suggestion: string | undefined) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(props.initial ?? "");
  const [suggesting, setSuggesting] = useState(props.suggest?.initial !== undefined);
  const [code, setCode] = useState(props.suggest?.initial ?? props.suggest?.lineText ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const area = useRef<HTMLTextAreaElement>(null);
  const codeArea = useRef<HTMLTextAreaElement>(null);
  const toggled = useRef(false);
  const { firstField } = props;
  useEffect(() => {
    (firstField?.current ?? area.current)?.focus();
  }, [firstField]);
  useEffect(() => {
    if (suggesting && toggled.current) codeArea.current?.focus();
  }, [suggesting]);
  const withSuggestion = !!props.suggest && suggesting;
  const ready = !!text.trim() || withSuggestion;

  async function save() {
    if (!ready || saving) return;
    const invalid = props.validate?.();
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await props.onSave(text.trim(), withSuggestion ? code : undefined);
    } catch (e) {
      setError(messageOf(e));
      setSaving(false);
    }
  }
  const saveKeys = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
  };

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
      {props.notice && (
        <p className="small muted linked-notice" role="note">
          {props.notice}
        </p>
      )}
      <textarea
        ref={area}
        className="input"
        aria-label={props.label}
        placeholder={withSuggestion ? "Why this change (optional)" : "Write a comment"}
        rows={3}
        maxLength={65_000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={saveKeys}
      />
      {props.suggest && (
        <div className="suggest">
          <button
            type="button"
            className={`btn xs${suggesting ? " on neutral" : ""}`}
            aria-pressed={suggesting}
            onClick={() => {
              toggled.current = true;
              if (!suggesting && !code && props.suggest?.lineText) setCode(props.suggest.lineText);
              setSuggesting((on) => !on);
            }}
          >
            ± Suggest a change
          </button>
          {suggesting && (
            <>
              <textarea
                ref={codeArea}
                className="input mono suggest-code"
                aria-label={`Suggested change for ${props.suggest.lines}`}
                placeholder={props.suggest.lineText === undefined ? "The code as it should be" : undefined}
                rows={Math.min(8, Math.max(2, code.split("\n").length))}
                spellCheck={false}
                maxLength={65_000}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={saveKeys}
              />
              {props.suggest.inBody ? (
                <span className="faint small">
                  In the review body GitHub can't apply it, so it posts as code headed "Suggested change" for the author
                  to copy. Left empty, it suggests deleting {props.suggest.lines.startsWith("lines") ? "them" : "it"}.
                </span>
              ) : (
                <span className="faint small">
                  Replaces {props.suggest.lines} when the author accepts it on GitHub. Left empty, it suggests deleting{" "}
                  {props.suggest.lines.startsWith("lines") ? "them" : "it"}.
                </span>
              )}
            </>
          )}
        </div>
      )}
      {error && (
        <p className="error-text small" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="btn sm primary" disabled={saving || !ready} onClick={save}>
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
  if (draft.source === "alden") return <AldenLabel draft={draft} />;
  return draft.source === "claude" ? <span className="chip from-claude">from Claude</span> : null;
}

/** A suggested change, as it will post: the code that replaces the line(s). */
function SuggestionBlock({ code }: { code: string }) {
  return (
    <div className="draft-suggestion">
      <span className="label">Suggested change</span>
      {code ? <pre className="mono">{code}</pre> : <span className="faint small">Deletes the line(s).</span>}
    </div>
  );
}

/**
 * A place in the briefing you can comment on: your drafts there, and Comment, which opens the editor for it in the
 * Comments drawer.
 */
export function CommentSlot(props: {
  anchor: Anchor;
  comments: BriefingComments;
  onComment: (place: CommentPlace) => void;
  compact?: boolean;
}) {
  const { anchor, comments } = props;
  const here = comments.drafts.filter((d) => onPlace(d, anchor));
  const where = whereText(anchor);
  return (
    <div className={`comment-slot${props.compact ? " compact" : ""}`}>
      {here.length > 0 && (
        <ul className="drafts-here visually-plain" aria-label={`Your comments on ${where}`}>
          {here.map((d) => (
            <li key={d.id}>
              <span className="faint mono">{d.state === "outdated" ? "outdated draft" : "draft"}</span>
              <Source draft={d} />
              <span className="body">{d.body || (d.suggestion !== undefined ? "Suggested change" : "")}</span>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className={props.compact ? "link-button small" : "btn xs"}
        aria-label={`Comment on ${where}`}
        aria-controls="comments-drawer"
        onClick={(e) => {
          // Safari doesn't focus a button you click; focus comes back here when the editor closes.
          e.currentTarget.focus();
          props.onComment({
            path: anchor.path,
            ...(anchor.line !== undefined ? { line: anchor.line } : {}),
            side: "RIGHT",
          });
        }}
      >
        Comment
      </button>
    </div>
  );
}

/** "12" or "4–9" (a hyphen works too): the line, or the first and last of a range. */
export function parseLines(text: string): { line: number; startLine?: number } | undefined {
  const match = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(text);
  if (!match) return undefined;
  const first = Number(match[1]);
  const last = match[2] ? Number(match[2]) : first;
  if (first < 1 || last < first) return undefined;
  return last === first ? { line: first } : { startLine: first, line: last };
}

/** Any line (or lines) of a changed file: pick the file and the line, then write. */
function LineForm(props: {
  files: { path: string; status: string }[];
  /** The PR's diff, to say before saving when a line isn't in it. */
  diff?: PrDiff | undefined;
  initial?: Extract<Editing, { kind: "line" }>["initial"];
  onSave: (draft: NewDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const { initial } = props;
  const [path, setPath] = useState(initial?.path ?? props.files[0]?.path ?? "");
  const [lineInput, setLineInput] = useState(
    initial?.line
      ? initial.startLine && initial.startLine < initial.line
        ? `${initial.startLine}–${initial.line}`
        : String(initial.line)
      : "",
  );
  const select = useRef<HTMLSelectElement>(null);
  const lines = parseLines(lineInput);
  const file = props.files.find((f) => f.path === path);
  const side = file?.status === "removed" ? "LEFT" : "RIGHT";
  const inBody = lines && path ? goesInBody(props.diff, { path, ...lines, side }) : undefined;
  return (
    <CommentEditor
      label="Comment"
      initial={initial?.body}
      firstField={select}
      validate={() => (!path ? "Pick a file." : !lines ? "Give a line number, or a range like 4–9." : undefined)}
      notice={inBody && lines ? linkedNotice(lines) : undefined}
      suggest={
        side === "RIGHT"
          ? { lines: lines ? linesText(lines) : "the line", initial: initial?.suggestion, inBody }
          : undefined
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
              placeholder="12 or 4–9"
              value={lineInput}
              onChange={(e) => setLineInput(e.target.value.replace(/[^\d\s\-–]/g, ""))}
            />
          </label>
        </div>
      }
      onCancel={props.onCancel}
      onSave={(body, suggestion) =>
        props.onSave(lineDraft({ path, side, ...(lines as { line: number; startLine?: number }) }, body, suggestion))
      }
    />
  );
}

/**
 * One draft in the drawer: where it posts, who wrote it, the start of its text (and its suggested change); Edit and
 * Delete, or Rewrite and Delete when it's outdated.
 */
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
  const what = draft.path
    ? `comment on ${whereText(draft)}`
    : draft.linkTo
      ? `note linking to ${whereText(draft.linkTo)}`
      : "general note";
  const outdated = draft.state === "outdated";
  const canSuggest = (!!draft.path && !!draft.line && draft.side !== "LEFT") || !!draft.linkTo?.line;
  const suggestLines = draft.linkTo ?? draft;
  return (
    <li className={`draft${outdated ? " outdated" : ""}`}>
      <div className="draft-head">
        <span className="draft-where">
          {draft.path ? (
            <>
              On <span className="mono">{draft.path}</span>
              {draft.line ? `, ${linesText({ line: draft.line, startLine: draft.startLine })}` : ""}
              {draft.side === "LEFT" ? " (old side)" : ""}
            </>
          ) : draft.linkTo ? (
            <span title={linkedTitle(draft)}>
              In the review body · links to <span className="mono">{draft.linkTo.path}</span>
              {draft.linkTo.line !== undefined ? `, ${linkLines(draft.linkTo)}` : ""}
            </span>
          ) : (
            "In the review body"
          )}
        </span>
        <Source draft={draft} />
        {outdated && <span className="pill warn">Outdated</span>}
      </div>
      {editing ? (
        <CommentEditor
          label={`Edit ${what}`}
          initial={draft.body}
          suggest={
            canSuggest
              ? {
                  lines: linesText({ line: suggestLines.line ?? 1, startLine: suggestLines.startLine }),
                  initial: draft.suggestion,
                  inBody: !!draft.linkTo,
                }
              : undefined
          }
          onCancel={stopEditing}
          onSave={async (body, suggestion) => {
            await comments.edit(draft.id, {
              body,
              ...(suggestion !== undefined
                ? { suggestion }
                : draft.suggestion !== undefined
                  ? { suggestion: null }
                  : {}),
            });
            stopEditing();
          }}
        />
      ) : (
        <>
          {draft.body && <p className="draft-body excerpt">{draft.body}</p>}
          {draft.suggestion !== undefined && <SuggestionBlock code={draft.suggestion} />}
        </>
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
              <span className="small">Delete this {draft.path ? "comment" : "note"}?</span>
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
          ) : draft.source === "alden" && !outdated ? (
            <AldenDraftActs
              draft={draft}
              what={what}
              comments={comments}
              editButton={editButton}
              onEdit={() => setEditing(true)}
              onDropped={props.onDeleted}
            />
          ) : (
            <>
              {outdated ? (
                <button type="button" className="btn xs" aria-label={`Rewrite ${what}`} onClick={props.onRewrite}>
                  Rewrite
                </button>
              ) : (
                <button
                  ref={editButton}
                  type="button"
                  className="btn xs"
                  aria-label={`Edit ${what}`}
                  onClick={() => setEditing(true)}
                >
                  Edit
                </button>
              )}
              <button
                type="button"
                className="btn xs quiet"
                aria-label={`Delete ${what}`}
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
  const toPost = toSend(comments.drafts);
  const body = reviewBody(comments.body, toPost);
  const inline = toPost.filter((d) => d.path);
  const replies = toPost.filter((d) => d.inReplyTo && d.body.trim()).length;
  const blocked = cannotSend(comments.event, comments.body, toPost);
  const left = unkept(comments.drafts).length;
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
        {inline.length > 0 ? `, with ${plural(inline.length, "comment")} on lines` : ""}
        {replies > 0
          ? `${inline.length > 0 ? " and" : ", with"} ${plural(replies, "reply", "replies")} in threads`
          : ""}
        .
      </p>
      {left > 0 && <p className="muted small">{plural(left, "draft")} by Alden not kept won't be sent.</p>}
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
          <h4 className="label">Comments on lines · {inline.length}</h4>
          <ul className="visually-plain confirm-list">
            {groupDrafts(inline, props.files).flatMap((g) =>
              g.drafts.map((d) => (
                <li key={d.id}>
                  <span className="draft-head">
                    <span className="place">{placeText(d)}</span>
                    <Source draft={d} />
                  </span>
                  {d.body && <p className="draft-body">{d.body}</p>}
                  {d.suggestion !== undefined && <SuggestionBlock code={d.suggestion} />}
                </li>
              )),
            )}
          </ul>
        </div>
      )}
      <ReplySummary drafts={toPost} threads={comments.threads?.threads} heading="Replies in threads" />
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

/** Where focus goes when the drawer is asked to show something: its heading, or the review body (`onFinish`). */
export type DrawerFocus = { to: "head" | "finish"; n: number } | ({ to: "reply" } & ReplyFocus);

/**
 * The Comments drawer, beside the briefing (a full-width sheet in narrow windows): the drafts by where they'll post
 * (on lines, in the review body), the editor, "Add a general note", the review body, the verdict and Send at the
 * bottom. Nothing posts until you've seen the summary and pressed Send there. Esc closes it (after an open editor or
 * summary has taken its own Esc).
 */
export function CommentsDrawer(props: {
  comments: BriefingComments;
  /** The briefing's files, for "Comment on a line…"; absent before a briefing. */
  files: Briefing["files"] | undefined;
  open: boolean;
  onClose: () => void;
  editing: Editing | undefined;
  onEditing: (editing: Editing | undefined) => void;
  focus: DrawerFocus | undefined;
  /** Where focus goes back to when a place's editor closes: the Comment button or the line it came from. */
  returnFocus: RefObject<HTMLElement | null>;
  /**
   * The PR's diff, once loaded: the editor says before you save when a line isn't in it (so the comment goes in the
   * review body, linking there). Without it, the server decides, and the drawer lists the comment where it went.
   */
  diff?: PrDiff | undefined;
}) {
  const { comments, editing, onEditing, open, files } = props;
  const placeInBody = editing?.kind === "place" ? goesInBody(props.diff, editing.place) : undefined;
  const [confirming, setConfirming] = useState(false);
  const [sent, setSent] = useState<SendReviewResult>();
  const [checking, setChecking] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const lineButton = useRef<HTMLButtonElement>(null);
  const noteButton = useRef<HTMLButtonElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const bodyField = useRef<HTMLTextAreaElement>(null);
  const sentLine = useRef<HTMLParagraphElement>(null);
  const restore = useRef<RefObject<HTMLElement | null> | undefined>(undefined);
  const formOpen = editing !== undefined;
  useEffect(() => {
    if (formOpen || !restore.current) return;
    const target = restore.current.current;
    restore.current = undefined;
    if (target?.isConnected) target.focus();
    else heading.current?.focus();
  });
  useEffect(() => {
    if (sent) sentLine.current?.focus();
  }, [sent]);
  const { focus } = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when asked again
  useEffect(() => {
    // A thread's Reply box takes its own focus (see Conversation).
    if (!focus || !open || focus.to === "reply") return;
    if (focus.to === "finish" && bodyField.current) {
      bodyField.current.scrollIntoView?.({ block: "nearest" });
      bodyField.current.focus();
    } else heading.current?.focus();
  }, [focus]);
  // The next review has begun.
  const hasDrafts = comments.drafts.length > 0;
  useEffect(() => {
    if (hasDrafts) setSent(undefined);
  }, [hasDrafts]);
  // Starting a comment leaves the summary: it would no longer be what posts.
  useEffect(() => {
    if (formOpen) setConfirming(false);
  }, [formOpen]);
  // A new PR starts a new review.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the PR changes
  useEffect(() => {
    setConfirming(false);
    setSent(undefined);
  }, [comments.pr]);

  const fileOrder = (files ?? []).map((f) => f.path);
  // Rewriting before there's a briefing: the draft's own file is the one to pick.
  const rewriting = editing?.kind === "line" ? editing.initial?.path : undefined;
  const lineFiles = files ?? (rewriting ? [{ path: rewriting, status: "modified" }] : undefined);
  const onLines = groupDrafts(
    comments.drafts.filter((d) => d.path),
    fileOrder,
  ).flatMap((g) => g.drafts);
  const notes = comments.drafts.filter((d) => !d.path && !d.inReplyTo);
  const count = comments.drafts.length;
  // Alden's drafts you haven't kept stay behind when you send.
  const sendCount = toSend(comments.drafts).length;
  const blocked = cannotSend(comments.event, comments.body, toSend(comments.drafts));
  const closeForm = (back: RefObject<HTMLElement | null>) => {
    restore.current = back;
    onEditing(undefined);
  };
  const rewrite = (d: ReviewDraft) =>
    onEditing(
      d.path
        ? {
            kind: "line",
            initial: { path: d.path, line: d.line, startLine: d.startLine, body: d.body, suggestion: d.suggestion },
            replaces: d.id,
          }
        : { kind: "note", initial: d.body, replaces: d.id },
    );
  const row = (d: ReviewDraft) => (
    <DraftRow
      key={d.id}
      draft={d}
      comments={comments}
      onDeleted={() => heading.current?.focus()}
      onRewrite={() => rewrite(d)}
    />
  );

  return (
    <aside
      id="comments-drawer"
      className="comments-drawer"
      aria-labelledby="comments-drawer-title"
      hidden={!open}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      <div className="drawer-head">
        <h2 className="h3" id="comments-drawer-title" ref={heading} tabIndex={-1}>
          Comments
        </h2>
        <span className="faint small mono">{count > 0 ? plural(count, "draft") : ""}</span>
        <button
          type="button"
          className="btn xs quiet icon"
          aria-label="Close comments"
          title="Close  s"
          onClick={props.onClose}
        >
          ×
        </button>
      </div>
      <p className="drawer-intro muted small">
        Kept on this machine until you send them to <strong>{comments.pr}</strong> on GitHub, as one review.
      </p>

      <div className="drawer-scroll">
        {sent && (
          <p className="banner ok" role="status" tabIndex={-1} ref={sentLine}>
            <strong>Sent to GitHub.</strong> You {verdictOf(sent.review).past}
            {sent.posted > 0 ? ` with ${plural(sent.posted, "comment")}` : ""}
            {sent.resolved ? `, and resolved ${plural(sent.resolved, "thread")}` : ""}.{" "}
            <a href={sent.url} target="_blank" rel="noreferrer">
              See the review ↗
            </a>
          </p>
        )}
        {sent?.notResolved && sent.notResolved.length > 0 && (
          <p className="banner" role="status">
            The review posted, but GitHub wouldn't resolve {plural(sent.notResolved.length, "thread")}:{" "}
            {sent.notResolved.join("; ")}. Resolve {sent.notResolved.length === 1 ? "it" : "them"} on GitHub.
          </p>
        )}
        {sent?.learning && sent.learning.length > 0 && (
          <p className="sent-learned faint small">Alden learned: {sent.learning.join("; ")}</p>
        )}
        {comments.error && <p className="banner error">{comments.error}</p>}

        {confirming ? (
          <Confirm
            comments={comments}
            files={fileOrder}
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
            {editing?.kind === "place" && (
              <div className="card comment-form">
                <h3 className="comment-target">
                  {editing.replaces ? "Rewrite on " : "Comment on "}
                  <span className="mono">{editing.place.path}</span>, {linesText(editing.place)}
                  {editing.place.side === "LEFT" ? " (old side)" : ""}
                </h3>
                <CommentEditor
                  key={editing.n}
                  label={`Comment on ${whereText(editing.place)}`}
                  initial={editing.initial?.body}
                  notice={placeInBody ? linkedNotice(editing.place) : undefined}
                  suggest={
                    editing.place.side === "RIGHT" && editing.place.line !== undefined
                      ? {
                          lines: linesText(editing.place),
                          lineText: editing.place.lineText,
                          initial: editing.initial?.suggestion,
                          inBody: placeInBody,
                        }
                      : undefined
                  }
                  onCancel={() => closeForm(props.returnFocus)}
                  onSave={async (body, suggestion) => {
                    await comments.add(lineDraft(editing.place, body, suggestion));
                    if (editing.replaces) await comments.remove(editing.replaces);
                    closeForm(props.returnFocus);
                  }}
                />
              </div>
            )}
            {editing?.kind === "line" && lineFiles && (
              <div className="card comment-form">
                <h3 className="comment-target">
                  {editing.replaces ? "Rewrite on the current code" : "Comment on a line"}
                </h3>
                <LineForm
                  files={lineFiles}
                  diff={props.diff}
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
                <h3 className="comment-target">General note, in the review body</h3>
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

            {count === 0 ? (
              <p className="faint small">
                {comments.loading
                  ? "Reading your drafts…"
                  : "No comments yet. Comment on a place in the briefing or a line of the diff, or add a general note."}
              </p>
            ) : (
              <>
                <AldenDraftsBar comments={comments} />
                {onLines.length > 0 && (
                  <section className="drawer-group" aria-labelledby="drafts-on-lines">
                    <h3 className="label" id="drafts-on-lines">
                      On lines · {onLines.length}
                    </h3>
                    <p className="faint small">Each posts as a comment on its line in the PR's diff.</p>
                    <ul className="visually-plain card drafts">{onLines.map(row)}</ul>
                  </section>
                )}
                {notes.length > 0 && (
                  <section className="drawer-group" aria-labelledby="drafts-in-body">
                    <h3 className="label" id="drafts-in-body">
                      In the review body · {notes.length}
                    </h3>
                    <p className="faint small">
                      Added after what you write below, oldest first. A note on code outside the diff starts with a link
                      to it.
                    </p>
                    <ul className="visually-plain card drafts">{notes.map(row)}</ul>
                  </section>
                )}
                <ReplySummary
                  drafts={comments.drafts}
                  threads={comments.threads?.threads}
                  heading="Replies in threads"
                />
              </>
            )}

            {!formOpen && (
              <div className="form-actions">
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
                {files && files.length > 0 && (
                  <button
                    ref={lineButton}
                    type="button"
                    className="btn sm quiet"
                    onClick={() => {
                      setSent(undefined);
                      onEditing({ kind: "line" });
                    }}
                  >
                    Comment on a line…
                  </button>
                )}
              </div>
            )}

            <label className="field">
              Review body
              <textarea
                ref={bodyField}
                className="input"
                rows={3}
                placeholder="Optional. Your general notes are added after it."
                value={comments.body}
                onChange={(e) => comments.setBody(e.target.value)}
              />
            </label>
            <Conversation comments={comments} focus={focus?.to === "reply" ? focus : undefined} />
          </>
        )}
      </div>

      {!confirming && (
        <div className="drawer-foot">
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
            className="btn primary send"
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
            {sendCount > 0 ? `Send review · ${plural(sendCount, "comment")}` : "Send review"}
          </button>
          {formOpen ? (
            <p className="faint small">Save or cancel the comment you're writing first.</p>
          ) : (
            blocked && sendCount + comments.body.trim().length > 0 && <p className="faint small">{blocked}</p>
          )}
        </div>
      )}
    </aside>
  );
}
