import type { Anchor, Briefing, PrDiff } from "@alden/schema";
import {
  type CSSProperties,
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { takesInline } from "../diff";
import {
  type BriefingComments,
  type CommentPlace,
  cannotSend,
  groupDrafts,
  leftOut,
  linkedText,
  linkedTitle,
  type NewDraft,
  placeText,
  type ReviewDraft,
  type ReviewEvent,
  reviewBody,
  type SendReviewResult,
  toSend,
  type Unaddressed,
  unkept,
  whereText,
} from "../drafts";
import { plural } from "../format";
import { type AssistTarget, DraftMyReview, DraftWithAlden } from "./AldenAssist";
import { AldenDraftActs, AldenDraftsBar, AldenLabel, TonePicker } from "./AldenDrafts";
import { Conversation, type ReplyFocus, ReplySummary } from "./Conversation";
import { DraftText } from "./DraftText";

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
      /** An outdated draft being put on the line you pick ("Pick a line"): it moves, keeping its id. */
      moves?: string;
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
  /** Where "Draft with Alden" writes for, when it's offered here (and a model is set up). */
  assist?: AssistTarget | undefined;
  /** `assisted`: the text came from "Draft with Alden", and whether you changed it before saving. */
  onSave: (body: string, suggestion: string | undefined, assisted?: { edited: boolean }) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(props.initial ?? "");
  const [suggesting, setSuggesting] = useState(props.suggest?.initial !== undefined);
  const [code, setCode] = useState(props.suggest?.initial ?? props.suggest?.lineText ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  /** What "Draft with Alden" put in the box, until Undo. */
  const [assisted, setAssisted] = useState<string>();
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
      await props.onSave(
        text.trim(),
        withSuggestion ? code : undefined,
        assisted !== undefined ? { edited: text.trim() !== assisted.trim() } : undefined,
      );
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
      {props.assist && (
        <DraftWithAlden
          target={props.assist}
          text={text}
          onText={(next) => {
            setText(next);
            area.current?.focus();
          }}
          onAssisted={setAssisted}
        />
      )}
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
      assist={path ? { path, side, ...lines } : undefined}
      onCancel={props.onCancel}
      onSave={(body, suggestion, assisted) =>
        props.onSave({
          ...lineDraft({ path, side, ...(lines as { line: number; startLine?: number }) }, body, suggestion),
          ...(assisted ? { assisted } : {}),
        })
      }
    />
  );
}

/** "retry.py:88", "retry.py:84–88" or "retry.py": a place by its file's name, as the drawer's cards say it. */
const shortPlace = (p: { path?: string | undefined; line?: number | undefined; startLine?: number | undefined }) =>
  p.path ? placeText({ ...p, path: p.path.split("/").pop() ?? p.path }) : "";

/** Who wrote a draft, as the first word on its card: you, Alden (until kept, and after), or Claude Code. */
export const provenance = (d: ReviewDraft) =>
  d.source === "alden" || d.drafted ? "Alden" : d.source === "claude" ? "Claude Code" : "you";

/** A draft's state, on the right of its card. */
export const draftState = (d: ReviewDraft): "outdated" | "suggested" | "kept" | "draft" =>
  d.state === "outdated" ? "outdated" : d.source === "alden" ? "suggested" : d.drafted ? "kept" : "draft";

/** Where a draft posts, by its file's name: "charge.ts:4–9", "links to api.ts:9", or "general". */
function shortWhere(d: ReviewDraft) {
  if (d.path) return `${shortPlace(d)}${d.side === "LEFT" ? " (old side)" : ""}`;
  if (d.linkTo) return `links to ${shortPlace(d.linkTo)}`;
  return "general";
}

/**
 * One draft in the drawer as a card: who wrote it, where it posts and its state in one mono line, then its text (and
 * suggested change). Alden's drafts are dashed with Keep, Edit and Drop until you keep them; then they look like
 * yours. Outdated drafts dim and say where their lines changed, with "Move to new lines" (or "Pick a line").
 */
function DraftCard(props: {
  draft: ReviewDraft;
  comments: BriefingComments;
  onPickLine: () => void;
  onDeleted: () => void;
  onDropped: (draft: ReviewDraft) => void;
}) {
  const { draft, comments } = props;
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
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
  const state = draftState(draft);
  const outdated = state === "outdated";
  const pending = draft.source === "alden" && !outdated;
  const canSuggest = (!!draft.path && !!draft.line && draft.side !== "LEFT") || !!draft.linkTo?.line;
  const suggestLines = draft.linkTo ?? draft;
  const who = provenance(draft);
  const { movedTo } = draft;
  const move = async () => {
    if (!movedTo || !comments.move) return;
    setBusy(true);
    setError(undefined);
    try {
      await comments.move(draft.id, movedTo);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={`draft dcard ${state}${pending ? " pending" : ""}`}>
      <div className="dcard-head">
        <span className={`dcard-who who-${who === "you" ? "you" : who === "Alden" ? "alden" : "claude"}`}>{who}</span>
        <span
          className="draft-where dcard-where"
          title={draft.path ?? (draft.linkTo ? `${linkedText(draft)}. ${linkedTitle(draft)}` : "In the review body")}
        >
          {shortWhere(draft)}
        </span>
        <span className="dcard-state">{state}</span>
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
          {draft.body && <DraftText text={draft.body} />}
          {draft.suggestion !== undefined && <SuggestionBlock code={draft.suggestion} />}
        </>
      )}
      {outdated && !editing && (
        <p className="dcard-moved">
          {draft.changedIn ? `These lines changed in ${draft.changedIn.slice(0, 7)}` : "These lines changed"}
          {" · "}
          {movedTo && comments.move ? (
            <button
              type="button"
              className="link-button"
              disabled={busy}
              aria-label={`Move ${what} to new lines, ${placeText(movedTo)}`}
              title={`Puts it on ${whereText(movedTo)}, where this code reads most like it now. Check it reads right.`}
              onClick={() => void move()}
            >
              {busy ? "Moving…" : "Move to new lines"}
            </button>
          ) : (
            <button
              type="button"
              className="link-button"
              aria-label={`Pick a line for ${what}`}
              title="Alden couldn't tell where this code went. Pick the line it belongs on now."
              onClick={props.onPickLine}
            >
              Pick a line
            </button>
          )}
        </p>
      )}
      {!editing && (
        <div className="draft-acts dcard-acts">
          {confirming ? (
            <>
              <span className="small">Delete this {draft.path ? "comment" : "note"}?</span>
              <button
                type="button"
                className="dcard-act"
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
              <button ref={keepButton} type="button" className="dcard-act" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </>
          ) : pending ? (
            <AldenDraftActs
              draft={draft}
              what={what}
              comments={comments}
              editButton={editButton}
              onEdit={() => setEditing(true)}
              onDropped={() => props.onDropped(draft)}
            />
          ) : (
            <>
              {!outdated && (
                <button
                  ref={editButton}
                  type="button"
                  className="dcard-act"
                  aria-label={`Edit ${what}`}
                  onClick={() => setEditing(true)}
                >
                  Edit
                </button>
              )}
              <button
                type="button"
                className="dcard-act"
                aria-label={`Delete ${what}`}
                onClick={() => setConfirming(true)}
              >
                Delete
              </button>
            </>
          )}
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

/** An Alden draft you just dropped, dimmed where it was until the drawer shows another PR. */
function DroppedCard({ draft }: { draft: ReviewDraft }) {
  return (
    <li className="draft dcard dropped" aria-label={`Dropped: ${draft.body}`}>
      <div className="dcard-head">
        <span className="dcard-who who-alden">Alden</span>
        <span className="dcard-where">{shortWhere(draft)}</span>
        <span className="dcard-state">dropped</span>
      </div>
      {draft.body && <p className="draft-body">{draft.body}</p>}
    </li>
  );
}

/**
 * Brings a place Alden flagged into view in the briefing or diff, and focuses it: "Look first" in the summary before
 * Approve. Whatever shows the place can also listen for `alden:look-at` (detail: path and line).
 */
export function lookAt(place: { path?: string | undefined; line?: number | undefined; title?: string }) {
  window.dispatchEvent(new CustomEvent("alden:look-at", { detail: place }));
  if (!place.path) return;
  const esc = (s: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/"/g, '\\"'));
  const marked = `[data-comment-path="${esc(place.path)}"]${place.line !== undefined ? `[data-comment-line="${place.line}"]` : ""}`;
  const target =
    document.querySelector<HTMLElement>(`.review-main ${marked}`) ??
    document.querySelector<HTMLElement>(`.review-main [aria-label="Comment on ${esc(whereText(place))}"]`);
  if (!target) return;
  target.scrollIntoView?.({ block: "center" });
  if (target.tabIndex < 0 && !target.hasAttribute("tabindex")) target.tabIndex = -1;
  target.focus();
}

/** "acme/api #1": a PR as the summary's meta line says it. */
const prMeta = (pr: string) => pr.replace(/#(\d+)$/, " #$1");

/** The elements Tab moves between inside the send dialog. */
const tabbable = (root: HTMLElement) =>
  [
    ...root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], summary, textarea, input, select, [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((e) => !e.closest("details:not([open]) > :not(summary)"));

/**
 * The summary before anything posts, as a dialog: the verdict, what goes on lines and in the body, Alden's drafts you
 * kept (posted as you), and what stays behind; before Approve, the places Alden flagged that you didn't comment on,
 * each with "Look first". "See exactly what posts" opens the text itself. ⌘↵ sends, Esc goes back.
 */
function SendDialog(props: {
  comments: BriefingComments;
  files: string[];
  onBack: () => void;
  onLook: (place: Unaddressed) => void;
  onSent: (result: SendReviewResult) => void;
}) {
  const { comments } = props;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const toPost = toSend(comments.drafts);
  const body = reviewBody(comments.body, toPost);
  const inline = toPost.filter((d) => d.path);
  const notes = toPost.filter((d) => !d.path && !d.inReplyTo).length;
  const replies = toPost.filter((d) => d.inReplyTo && d.body.trim()).length;
  const resolves = toPost.filter((d) => d.inReplyTo && d.resolve).length;
  const keptFromAlden = toPost.filter((d) => d.drafted).length;
  const outdated = leftOut(comments.drafts).length;
  const notKept = unkept(comments.drafts).length;
  const blocked = cannotSend(comments.event, comments.body, toPost);
  const verdict = verdictOf(comments.event);
  const text = comments.body.trim();
  const inBody =
    text && notes > 0
      ? `your text and ${plural(notes, "note")}`
      : text
        ? "your text"
        : notes > 0
          ? plural(notes, "note")
          : "nothing";
  const flagged = comments.event === "APPROVE" ? comments.unaddressed : [];

  async function send() {
    if (sending || blocked) return;
    setSending(true);
    setError(undefined);
    try {
      props.onSent(await comments.send());
    } catch (e) {
      setError(messageOf(e));
      setSending(false);
    }
  }
  const row = (label: string, value: string) => (
    <div className="send-row-v3" key={label}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );

  return createPortal(
    <div className="send-backdrop">
      <div
        ref={box}
        className="send-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="send-title"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !sending) {
            e.stopPropagation();
            e.preventDefault();
            props.onBack();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          } else if (e.key === "Tab" && box.current) {
            // Focus stays in the dialog while it's open.
            const all = tabbable(box.current);
            const first = all[0];
            const last = all[all.length - 1];
            if (!first || !last) return;
            if (e.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="send-top">
          <span className="send-meta">{prMeta(comments.pr)}</span>
          <h2 className="send-title" id="send-title" ref={heading} tabIndex={-1}>
            Send this review to GitHub?
          </h2>
        </div>
        <dl className="send-rows">
          {row("Verdict", verdict.label)}
          {row("On lines", plural(inline.length, "comment"))}
          {row("In the body", inBody)}
          {keptFromAlden > 0 && row("Drafted by Alden, kept by you", `${keptFromAlden}, posted as you`)}
          {replies > 0 && row("Replies in threads", plural(replies, "reply", "replies"))}
          {resolves > 0 && row("Resolved after it posts", plural(resolves, "thread"))}
          {outdated > 0 && row("Outdated, left out", String(outdated))}
          {notKept > 0 && row("Alden's drafts not kept, left out", String(notKept))}
        </dl>
        {flagged.length > 0 && (
          <div className="send-flagged">
            <strong>Alden flagged {plural(flagged.length, "place")} you didn't comment on</strong>
            <ul className="visually-plain">
              {flagged.map((u) => (
                <li key={`${u.checkId}${placeText(u)}${u.title}`}>
                  {[u.path ? placeText(u) : undefined, u.title].filter(Boolean).join(" · ")}.{" "}
                  <button type="button" className="link-button" onClick={() => props.onLook(u)}>
                    Look first
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <details className="send-exact">
          <summary>See exactly what posts</summary>
          <div className="send-exact-body">
            <h3 className="label">Review body</h3>
            {body ? <p className="draft-body">{body}</p> : <p className="faint small">No body.</p>}
            {inline.length > 0 && (
              <>
                <h3 className="label">Comments on lines · {inline.length}</h3>
                <ul className="visually-plain confirm-list">
                  {groupDrafts(inline, props.files).flatMap((g) =>
                    g.drafts.map((d) => (
                      <li key={d.id}>
                        <span className="place mono small">
                          {placeText(d)} · {provenance(d)}
                        </span>
                        {d.body && <p className="draft-body">{d.body}</p>}
                        {d.suggestion !== undefined && <SuggestionBlock code={d.suggestion} />}
                      </li>
                    )),
                  )}
                </ul>
              </>
            )}
            <ReplySummary drafts={toPost} threads={comments.threads?.threads} heading="Replies in threads" />
          </div>
        </details>
        {(error ?? blocked) && (
          <p className="banner error send-error" role="alert">
            {error ?? blocked}
          </p>
        )}
        <div className="send-actions">
          <span className="send-keys">⌘↵ to send</span>
          <button type="button" className="v3-btn" disabled={sending} onClick={props.onBack}>
            Back
          </button>
          <button type="button" className="v3-btn primary" disabled={sending || !!blocked} onClick={() => void send()}>
            {sending ? "Sending…" : "Send review"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** "✓ Sent to GitHub · See the review ↗", at the bottom centre of the briefing for 4 seconds after a send. */
function SentToast({ sent }: { sent: SendReviewResult }) {
  const [left, setLeft] = useState<number>();
  useLayoutEffect(() => {
    const main = document.querySelector(".review-main")?.getBoundingClientRect();
    if (main && main.width > 0) setLeft(main.left + main.width / 2);
  }, []);
  return createPortal(
    <div className="sent-toast" role="status" style={left !== undefined ? { left } : undefined}>
      <span className="sent-tick" aria-hidden="true">
        ✓
      </span>
      Sent to GitHub
      <a href={sent.url} target="_blank" rel="noreferrer">
        See the review ↗
      </a>
    </div>,
    document.body,
  );
}

/** Where focus goes when the drawer is asked to show something: its heading, or the review body (`onFinish`). */
export type DrawerFocus = { to: "head" | "finish"; n: number } | ({ to: "reply" } & ReplyFocus);

/** The drawer's width: 380 to start, 320 to 760 when you drag its edge. */
export const DRAWER_WIDTH = { min: 320, max: 760, start: 380 } as const;
const WIDTH_KEY = "alden.comments.width";
const clampWidth = (w: number) => Math.round(Math.min(DRAWER_WIDTH.max, Math.max(DRAWER_WIDTH.min, w)));

/** The drawer's width as you last dragged it, remembered on this machine (localStorage); 380 until you do. */
function useDrawerWidth(): [number, (w: number) => void, (w: number) => void] {
  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = Number(window.localStorage.getItem(WIDTH_KEY));
      if (saved >= DRAWER_WIDTH.min && saved <= DRAWER_WIDTH.max) return saved;
    } catch {
      // storage blocked: the default
    }
    return DRAWER_WIDTH.start;
  });
  const save = useCallback((w: number) => {
    const next = clampWidth(w);
    setWidth(next);
    try {
      if (next === DRAWER_WIDTH.start) window.localStorage.removeItem(WIDTH_KEY);
      else window.localStorage.setItem(WIDTH_KEY, String(next));
    } catch {
      // storage blocked: the width lasts for this page
    }
  }, []);
  return [width, (w: number) => setWidth(clampWidth(w)), save];
}

type DrawerTab = "drafts" | "conversation";

/**
 * The Comments drawer, beside the briefing (a full-width sheet in narrow windows): Drafts (the tone Alden writes in,
 * your drafts by where they'll post, the editor, the review body) and Conversation (the PR's threads), with the
 * verdict and "Review and send" at the bottom. Drag its left edge to resize it (double-click puts it back); closed,
 * it's a narrow rail you click (or press S) to open. Nothing posts until you've seen the summary and pressed Send
 * there. Esc closes it (after an open editor or summary has taken its own Esc).
 */
export function CommentsDrawer(props: {
  comments: BriefingComments;
  /** The briefing's files, for "Comment on a line…"; absent before a briefing. */
  files: Briefing["files"] | undefined;
  open: boolean;
  onClose: () => void;
  /** Opens it again from the rail it folds to; without it, closed is gone. */
  onOpen?: () => void;
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
  const [toast, setToast] = useState<SendReviewResult>();
  const [checking, setChecking] = useState(false);
  const [tab, setTab] = useState<DrawerTab>("drafts");
  const [replyFocus, setReplyFocus] = useState<ReplyFocus>();
  const [dropped, setDropped] = useState<ReviewDraft[]>([]);
  const [width, setWidth, saveWidth] = useDrawerWidth();
  const [dragging, setDragging] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const lineButton = useRef<HTMLButtonElement>(null);
  const noteButton = useRef<HTMLButtonElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const bodyField = useRef<HTMLTextAreaElement>(null);
  const restore = useRef<RefObject<HTMLElement | null> | undefined>(undefined);
  const formOpen = editing !== undefined;
  useEffect(() => {
    if (formOpen || !restore.current) return;
    const target = restore.current.current;
    restore.current = undefined;
    if (target?.isConnected) target.focus();
    else heading.current?.focus();
  });
  const { focus } = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when asked again
  useEffect(() => {
    if (!focus || !open) return;
    // A thread's Reply box takes its own focus (see Conversation).
    if (focus.to === "reply") {
      setTab("conversation");
      setReplyFocus(focus);
      return;
    }
    if (focus.to === "finish") setTab("drafts");
    if (focus.to === "finish" && bodyField.current) {
      bodyField.current.scrollIntoView?.({ block: "nearest" });
      bodyField.current.focus();
    } else heading.current?.focus();
  }, [focus]);
  // The review body is on the Drafts tab: onFinish waits for it to show.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once the tab has switched
  useEffect(() => {
    if (focus?.to === "finish" && tab === "drafts" && open && document.activeElement !== bodyField.current) {
      bodyField.current?.focus();
    }
  }, [tab]);
  // Writing a comment shows the Drafts tab, where the editor is.
  useEffect(() => {
    if (formOpen) setTab("drafts");
  }, [formOpen]);
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
    setDropped([]);
    setReplyFocus(undefined);
  }, [comments.pr]);
  // "Sent to GitHub" shows for 4 seconds.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(undefined), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const fileOrder = (files ?? []).map((f) => f.path);
  // Picking a line before there's a briefing: the draft's own file is the one to pick.
  const picking = editing?.kind === "line" ? editing.initial?.path : undefined;
  const lineFiles = files ?? (picking ? [{ path: picking, status: "modified" }] : undefined);
  const onLines = groupDrafts(
    comments.drafts.filter((d) => d.path),
    fileOrder,
  ).flatMap((g) => g.drafts);
  const notes = comments.drafts.filter((d) => !d.path && !d.inReplyTo);
  const count = comments.drafts.length;
  const threads = comments.threads;
  // Alden's drafts you haven't kept, and outdated ones, stay behind when you send.
  const sendCount = toSend(comments.drafts).length;
  const blocked = cannotSend(comments.event, comments.body, toSend(comments.drafts));
  const closeForm = (back: RefObject<HTMLElement | null>) => {
    restore.current = back;
    onEditing(undefined);
  };
  const pickLine = (d: ReviewDraft) =>
    onEditing({
      kind: "line",
      initial: { path: d.path, line: d.line, startLine: d.startLine, body: d.body, suggestion: d.suggestion },
      moves: d.id,
    });
  const droppedHere = (onLine: boolean) => dropped.filter((d) => !!d.path === onLine && !d.inReplyTo);
  const card = (d: ReviewDraft) => (
    <DraftCard
      key={d.id}
      draft={d}
      comments={comments}
      onDeleted={() => heading.current?.focus()}
      onDropped={(gone) => {
        setDropped((all) => [...all, gone]);
        heading.current?.focus();
      }}
      onPickLine={() => pickLine(d)}
    />
  );
  const startDrag = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    let last = w0;
    const move = (ev: MouseEvent) => {
      last = clampWidth(w0 + (x0 - ev.clientX));
      setWidth(last);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.classList.remove("drawer-resizing");
      setDragging(false);
      saveWidth(last);
    };
    document.body.style.cursor = "col-resize";
    document.body.classList.add("drawer-resizing");
    setDragging(true);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const tabs: { id: DrawerTab; label: string; n: number }[] = [
    { id: "drafts", label: "Drafts", n: count },
    ...(threads ? [{ id: "conversation" as const, label: "Conversation", n: threads.threads.length }] : []),
  ];
  const showTab = threads ? tab : "drafts";
  const chooseTab = (next: DrawerTab) => {
    setTab(next);
    if (next !== "conversation") setReplyFocus(undefined);
  };

  return (
    <>
      <aside
        id="comments-drawer"
        className={`comments-drawer v3${dragging ? " dragging" : ""}`}
        aria-labelledby="comments-drawer-title"
        hidden={!open}
        style={{ "--drawer-w": `${width}px` } as CSSProperties}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !e.defaultPrevented) {
            e.stopPropagation();
            props.onClose();
          }
        }}
      >
        {/* biome-ignore lint/a11y/useSemanticElements: an <hr> can't be dragged; this is the drawer's resizable edge */}
        <div
          className="drawer-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize comments"
          aria-valuemin={DRAWER_WIDTH.min}
          aria-valuemax={DRAWER_WIDTH.max}
          aria-valuenow={width}
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          onMouseDown={startDrag}
          onDoubleClick={() => saveWidth(DRAWER_WIDTH.start)}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 64 : 16;
            if (e.key === "ArrowLeft") saveWidth(width + step);
            else if (e.key === "ArrowRight") saveWidth(width - step);
            else if (e.key === "Home") saveWidth(DRAWER_WIDTH.start);
            else return;
            e.preventDefault();
          }}
        >
          <span />
        </div>
        <div className="drawer-head">
          <h2 className="visually-hidden" id="comments-drawer-title" ref={heading} tabIndex={-1}>
            Comments
          </h2>
          <div className="drawer-tabs" role="tablist" aria-label="Comments">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`drawer-tab-${t.id}`}
                aria-selected={showTab === t.id}
                aria-controls={`drawer-panel-${t.id}`}
                className="drawer-tab"
                aria-label={`${t.label} ${t.n}`}
                onClick={() => chooseTab(t.id)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                  e.preventDefault();
                  const i = tabs.findIndex((x) => x.id === t.id);
                  const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
                  if (!next) return;
                  chooseTab(next.id);
                  document.getElementById(`drawer-tab-${next.id}`)?.focus();
                }}
              >
                {t.label}
                <span className="drawer-tab-n">{t.n}</span>
              </button>
            ))}
          </div>
          <span className="drawer-px" aria-hidden="true">
            {dragging ? `${width}px` : ""}
          </span>
          <button
            type="button"
            className="drawer-collapse"
            aria-label="Close comments"
            title="Collapse · S"
            onClick={props.onClose}
          >
            S ›
          </button>
        </div>

        <div className="drawer-scroll">
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

          {showTab === "drafts" ? (
            <div className="drawer-panel" role="tabpanel" id="drawer-panel-drafts" aria-labelledby="drawer-tab-drafts">
              <TonePicker comments={comments} />
              {editing?.kind === "place" && (
                <div className="dcard comment-form">
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
                    assist={editing.place}
                    onCancel={() => closeForm(props.returnFocus)}
                    onSave={async (body, suggestion, assisted) => {
                      await comments.add({
                        ...lineDraft(editing.place, body, suggestion),
                        ...(assisted ? { assisted } : {}),
                      });
                      if (editing.replaces) await comments.remove(editing.replaces);
                      closeForm(props.returnFocus);
                    }}
                  />
                </div>
              )}
              {editing?.kind === "line" && lineFiles && (
                <div className="dcard comment-form">
                  <h3 className="comment-target">
                    {editing.moves
                      ? "Pick the line it belongs on now"
                      : editing.replaces
                        ? "Rewrite on the current code"
                        : "Comment on a line"}
                  </h3>
                  <LineForm
                    files={lineFiles}
                    diff={props.diff}
                    initial={editing.initial}
                    onCancel={() => closeForm(lineButton)}
                    onSave={async (draft) => {
                      const moving = editing.moves;
                      if (moving && comments.move && draft.path && draft.line !== undefined) {
                        const had = comments.drafts.find((d) => d.id === moving)?.suggestion;
                        await comments.move(moving, {
                          path: draft.path,
                          line: draft.line,
                          side: draft.side ?? "RIGHT",
                          ...(draft.startLine !== undefined ? { startLine: draft.startLine } : {}),
                          body: draft.body,
                          ...(draft.suggestion !== undefined
                            ? { suggestion: draft.suggestion }
                            : had !== undefined
                              ? { suggestion: null }
                              : {}),
                        });
                      } else {
                        await comments.add(draft);
                        if (editing.replaces ?? moving) await comments.remove((editing.replaces ?? moving) as string);
                      }
                      closeForm(lineButton);
                    }}
                  />
                </div>
              )}
              {editing?.kind === "note" && (
                <div className="dcard comment-form">
                  <h3 className="comment-target">General note, in the review body</h3>
                  <CommentEditor
                    label="General note"
                    initial={editing.initial}
                    assist={{ note: true }}
                    onCancel={() => closeForm(noteButton)}
                    onSave={async (body, _suggestion, assisted) => {
                      await comments.add({ body, ...(assisted ? { assisted } : {}) });
                      if (editing.replaces) await comments.remove(editing.replaces);
                      closeForm(noteButton);
                    }}
                  />
                </div>
              )}

              {count === 0 && dropped.length === 0 ? (
                <div className="drawer-empty">
                  <p className="faint small">
                    {comments.loading
                      ? "Reading your drafts…"
                      : "No comments yet. Comment on a place in the briefing or a line of the diff, or add a general note."}
                  </p>
                  <p className="faint small">
                    Kept on this machine until you send them to <strong>{comments.pr}</strong> on GitHub, as one review.
                  </p>
                </div>
              ) : (
                <>
                  <AldenDraftsBar comments={comments} onDropped={(gone) => setDropped((all) => [...all, ...gone])} />
                  {(onLines.length > 0 || droppedHere(true).length > 0) && (
                    <section className="drawer-group" aria-label={`On lines · ${onLines.length}`}>
                      <h3 className="drawer-label">On lines</h3>
                      <ul className="visually-plain dcards">
                        {onLines.map(card)}
                        {droppedHere(true).map((d) => (
                          <DroppedCard key={d.id} draft={d} />
                        ))}
                      </ul>
                    </section>
                  )}
                </>
              )}
              <section className="drawer-group" aria-label={`In the review body · ${notes.length}`}>
                <h3 className="drawer-label">In the review body</h3>
                <label className="field drawer-body-field">
                  <span className="visually-hidden">Review body</span>
                  <textarea
                    ref={bodyField}
                    className="input"
                    rows={2}
                    placeholder="Review body. Optional: your general notes are added after it."
                    value={comments.body}
                    onChange={(e) => comments.setBody(e.target.value)}
                  />
                </label>
                {(notes.length > 0 || droppedHere(false).length > 0) && (
                  <ul className="visually-plain dcards">
                    {notes.map(card)}
                    {droppedHere(false).map((d) => (
                      <DroppedCard key={d.id} draft={d} />
                    ))}
                  </ul>
                )}
              </section>
              <ReplySummary drafts={comments.drafts} threads={comments.threads?.threads} heading="Replies in threads" />

              {!formOpen && (
                <div className="drawer-adds">
                  <button
                    ref={noteButton}
                    type="button"
                    className="v3-btn"
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
                      className="v3-btn quiet"
                      onClick={() => {
                        setSent(undefined);
                        onEditing({ kind: "line" });
                      }}
                    >
                      Comment on a line…
                    </button>
                  )}
                  <DraftMyReview from="drawer" />
                </div>
              )}
            </div>
          ) : (
            <div
              className="drawer-panel"
              role="tabpanel"
              id="drawer-panel-conversation"
              aria-labelledby="drawer-tab-conversation"
            >
              <Conversation comments={comments} focus={replyFocus} />
            </div>
          )}
        </div>

        <div className="drawer-foot">
          {/* biome-ignore lint/a11y/useSemanticElements: a fieldset can't lay its buttons out as a grid */}
          <div className="v3-seg verdicts-v3" role="group" aria-label="Verdict">
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
          </div>
          <button
            ref={sendButton}
            type="button"
            className="v3-btn primary send"
            disabled={!!blocked || comments.loading || checking || formOpen || confirming}
            onClick={async () => {
              // Read the drafts once more, so the summary has anything Claude Code added since.
              setChecking(true);
              await comments.reload();
              setChecking(false);
              setSent(undefined);
              setConfirming(true);
            }}
          >
            Review and send · {sendCount}
          </button>
          <p className="drawer-foot-note">
            {formOpen
              ? "Save or cancel the comment you're writing first."
              : blocked && sendCount + comments.body.trim().length > 0
                ? blocked
                : "Nothing posts until you send."}
          </p>
        </div>
      </aside>
      {!open && props.onOpen && (
        <button
          type="button"
          className="comments-rail"
          aria-label={`Open comments${count > 0 ? `, ${plural(count, "draft")}` : ""}`}
          aria-controls="comments-drawer"
          aria-expanded={false}
          title="Open comments · S"
          onClick={props.onOpen}
        >
          <span className="rail-chev" aria-hidden="true">
            ‹
          </span>
          <span className="rail-label" aria-hidden="true">
            Comments
            {count > 0 && <span className="rail-n">{count}</span>}
          </span>
          <span className="rail-key" aria-hidden="true">
            S
          </span>
        </button>
      )}
      {confirming && (
        <SendDialog
          comments={comments}
          files={fileOrder}
          onBack={() => {
            restore.current = sendButton;
            setConfirming(false);
          }}
          onLook={(place) => {
            setConfirming(false);
            requestAnimationFrame(() => lookAt(place));
          }}
          onSent={(result) => {
            setConfirming(false);
            setSent(result);
            setToast(result);
            heading.current?.focus();
          }}
        />
      )}
      {toast && <SentToast sent={toast} />}
    </>
  );
}
