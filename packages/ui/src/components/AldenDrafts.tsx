import { type Ref, useState } from "react";
import { type BriefingComments, type ReviewDraft, repoOf, TONES, type Tone, unkept } from "../drafts";
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
          className="alden-act keep"
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
        className="alden-act edit"
        disabled={busy}
        aria-label={`Edit ${props.what}`}
        onClick={props.onEdit}
      >
        Edit
      </button>
      <button
        type="button"
        className="alden-act drop"
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
export function AldenDraftsBar({
  comments,
  onDropped,
}: {
  comments: BriefingComments;
  /** The drafts Drop all let go, to show dimmed where they were. */
  onDropped?: (drafts: ReviewDraft[]) => void;
}) {
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
    <section className="alden-drafts" aria-label="Alden's drafts">
      <p className="small">
        <strong>Alden drafted {plural(n, "comment")}</strong> for this PR. Keep, edit or drop each: {plural(n, "draft")}{" "}
        by Alden not kept won't be sent.
      </p>
      <div className="alden-drafts-acts">
        {comments.keep && (
          <button
            type="button"
            className="alden-act keep"
            disabled={busy}
            onClick={() => act(() => comments.keep?.() ?? Promise.resolve())}
          >
            Keep all
          </button>
        )}
        {comments.dropAlden && (
          <button
            type="button"
            className="alden-act drop"
            disabled={busy}
            onClick={() => {
              const gone = unkept(comments.drafts);
              return act(async () => {
                await comments.dropAlden?.();
                onDropped?.(gone);
              });
            }}
          >
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

/** What each tone means, under "Alden writes"; concise is the default. */
const TONE_LABELS: Record<Tone, { label: string; hint: (repo: string) => string }> = {
  terse: { label: "Terse", hint: () => "one line, no reasoning" },
  concise: { label: "Concise", hint: (repo) => `the default for ${repo}` },
  detailed: { label: "Detailed", hint: () => "why, impact and a fix" },
  teaching: { label: "Teaching", hint: () => "for newer teammates" },
};

/**
 * "Alden writes" at the top of the drawer's Drafts: the tone Alden drafts comments in for this repo (Terse, Concise,
 * Detailed or Teaching), saved for the repo. Hidden where the API has no tone to read.
 */
export function TonePicker({ comments }: { comments: BriefingComments }) {
  const [error, setError] = useState<string>();
  const { tone, setTone } = comments;
  if (!tone || !setTone) return null;
  const repo = repoOf(comments.pr).split("/").pop() ?? comments.pr;
  return (
    <div className="tone-picker">
      <div className="tone-top">
        <span className="tone-title" id="tone-title">
          Alden writes
        </span>
        <span className="tone-hint">{TONE_LABELS[tone].hint(repo)}</span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset can't lay its buttons out as a grid */}
      <div
        className="v3-seg tones"
        role="group"
        aria-labelledby="tone-title"
        title="How Alden writes the comments it drafts in this repo"
      >
        {TONES.map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={tone === t}
            onClick={async () => {
              setError(undefined);
              try {
                await setTone(t);
              } catch (e) {
                setError(`Couldn't change how Alden writes: ${messageOf(e)}`);
              }
            }}
          >
            {TONE_LABELS[t].label}
          </button>
        ))}
      </div>
      {error && (
        <p className="error-text small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
