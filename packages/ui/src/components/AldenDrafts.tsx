import { type Ref, useState } from "react";
import { type BriefingComments, type ReviewDraft, unkept } from "../drafts";
import { plural } from "../format";

/*
 * Alden's drafts in the Comments drawer: comments it drafted from the model's findings or on request (Draft my review), labelled "Drafted by Alden".
 * Each is only a suggestion until you keep or edit it, when it becomes yours; untouched, it's never sent, and none of
 * them approves anything.
 */

const messageOf = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

/** "Drafted by Alden" on a draft you haven't kept yet; "Drafted by Alden, kept" isn't shown: it's yours now. */
export function AldenLabel({ draft }: { draft: ReviewDraft }) {
  return draft.source === "alden" ? (
    <span className="chip from-alden" title="Alden drafted this from its model's finding. Keep or edit it to send it.">
      Drafted by Alden
    </span>
  ) : null;
}

/** Keep, Edit and Drop on one of Alden's drafts. Keep and Drop take effect at once: there's nothing of yours to lose. */
export function AldenDraftActs(props: {
  draft: ReviewDraft;
  /** "comment on src/pay.ts, line 2": what the buttons act on, for screen readers. */
  what: string;
  comments: BriefingComments;
  onEdit: () => void;
  onDropped: () => void;
  editButton?: Ref<HTMLButtonElement>;
}) {
  const { draft, comments } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await run();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {comments.keep && (
        <button
          type="button"
          className="btn xs"
          disabled={busy}
          aria-label={`Keep ${props.what}`}
          onClick={() => act(async () => comments.keep?.([draft.id]))}
        >
          Keep
        </button>
      )}
      <button
        ref={props.editButton}
        type="button"
        className="btn xs"
        disabled={busy}
        aria-label={`Edit ${props.what}`}
        onClick={props.onEdit}
      >
        Edit
      </button>
      <button
        type="button"
        className="btn xs quiet"
        disabled={busy}
        aria-label={`Drop ${props.what}`}
        onClick={() =>
          act(async () => {
            await comments.remove(draft.id);
            props.onDropped();
          })
        }
      >
        Drop
      </button>
      {error && (
        <span className="error-text small" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

/**
 * At the top of the drawer when Alden drafted comments you haven't kept: how many, that they won't be sent as they
 * are, and Keep all / Drop all.
 */
export function AldenDraftsBar({ comments }: { comments: BriefingComments }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const n = unkept(comments.drafts).length;
  if (n === 0) return null;
  const act = async (run: (() => Promise<void>) | undefined) => {
    if (!run) return;
    setBusy(true);
    setError(undefined);
    try {
      await run();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="alden-drafts card" aria-label="Alden's drafts">
      <p className="small">
        <strong>Alden drafted {plural(n, "comment")}</strong> for this PR. Keep, edit or drop each: {plural(n, "draft")}{" "}
        by Alden not kept won't be sent.
      </p>
      <div className="form-actions">
        {comments.keep && (
          <button
            type="button"
            className="btn xs"
            disabled={busy}
            onClick={() => act(() => comments.keep?.() ?? Promise.resolve())}
          >
            Keep all
          </button>
        )}
        {comments.dropAlden && (
          <button type="button" className="btn xs quiet" disabled={busy} onClick={() => act(comments.dropAlden)}>
            Drop all
          </button>
        )}
      </div>
      {error && (
        <p className="error-text small" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** "Draft ready" beside a finding Alden drafted a comment for that you haven't kept or dropped yet. */
export function DraftReady({ title, comments }: { title: string; comments: BriefingComments | undefined }) {
  const ready = comments?.drafts.some((d) => d.source === "alden" && d.drafted?.title === title);
  return ready ? (
    <span className="chip from-alden" style={{ marginLeft: 6 }} title="Alden drafted a comment: see Comments">
      Draft ready
    </span>
  ) : null;
}
