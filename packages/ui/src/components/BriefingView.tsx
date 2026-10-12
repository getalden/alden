import type {
  Anchor,
  Briefing,
  CheckResult,
  FeedbackItem,
  FromNote,
  LlmFinding,
  LlmSection,
  LookHere,
  Severity,
} from "@alden/schema";
import { type FormEvent, type ReactNode, useContext, useEffect, useId, useState } from "react";
import type { BriefingComments, CommentPlace } from "../drafts";
import { type BriefingFeedback, noteArea, type Verdict } from "../feedback";
import { formatUsd, plural, prFileUrl } from "../format";
import { excerptAround, guidedKey, guidedSteps, startGuided, useGuidedProgress } from "../guided";
import { onLinkClick, routePath } from "../router";
import { DraftReady } from "./AldenDrafts";
import { CommentSlot, placeAttrs, useReviewActions } from "./Comments";
import { ShowInDiffContext } from "./DiffView";
import { CodeAt, GuidedReview, type GuidedReviewProps, useBriefingDiff } from "./GuidedReview";
import { Mark } from "./Mark";

const anchorKey = (a: Anchor) => `${a.path}:${a.line ?? ""}`;

/** Only a place with a line can be picked with `c`; any place takes Comment (a whole file's goes in the review body). */
const withLine = (a: Anchor | undefined): (Anchor & { line: number }) | undefined =>
  a?.line ? { ...a, line: a.line } : undefined;

/** Links for every place the briefing points at: into the PR's diff on GitHub. Local changes have no page to link. */
function useAnchorLinks(briefing: Briefing): Map<string, string> {
  const [links, setLinks] = useState(new Map<string, string>());
  useEffect(() => {
    const target = briefing.target;
    if (target.kind !== "pr") return;
    const anchors: Anchor[] = [
      ...briefing.needsYourEyes.flatMap((i) => (i.anchor ? [i.anchor] : [])),
      ...briefing.checks.flatMap((c) => c.evidence.flatMap((e) => (e.anchor ? [e.anchor] : []))),
      ...(briefing.llm?.findings ?? []).flatMap((f) => f.anchors),
      ...briefing.files.map((f) => ({ path: f.path })),
    ];
    let cancelled = false;
    Promise.all(anchors.map(async (a) => [anchorKey(a), await prFileUrl(target.url, a.path, a.line)] as const)).then(
      (entries) => {
        if (!cancelled) setLinks(new Map(entries));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [briefing]);
  return links;
}

function Place({ anchor, links, arrow = false }: { anchor: Anchor; links: Map<string, string>; arrow?: boolean }) {
  const text = `${anchor.path}${anchor.line ? `:${anchor.line}` : ""}`;
  const href = links.get(anchorKey(anchor));
  const showInDiff = useContext(ShowInDiffContext);
  if (showInDiff) {
    // With a Diff tab: the place opens the diff there, and GitHub's diff stays a link beside it.
    return (
      <span className="place-links">
        <button
          type="button"
          className="place place-diff"
          title="Show in the Diff tab"
          onClick={() => showInDiff({ path: anchor.path, line: anchor.line })}
        >
          {text}
        </button>
        {href && (
          <a className="place-gh" href={href} target="_blank" rel="noreferrer" aria-label={`${text} on GitHub`}>
            GitHub ↗
          </a>
        )}
      </span>
    );
  }
  return href ? (
    <a className="place" href={href} target="_blank" rel="noreferrer">
      {text}
      {arrow ? " ↗" : ""}
    </a>
  ) : (
    <span className="place">{text}</span>
  );
}

export const SEVERITY: Record<Severity, string> = {
  critical: "critical",
  high: "high",
  medium: "med",
  low: "low",
  info: "—",
};
const STATUS: Record<CheckResult["status"], { glyph: string; label: string }> = {
  passed: { glyph: "✓", label: "Passed" },
  flagged: { glyph: "!", label: "Flagged" },
  skipped: { glyph: "", label: "Skipped" },
};

type Hidden = NonNullable<Briefing["learning"]>["hidden"];

/** Places left out for the same reason, together: three untested files are one line, not three. */
export function groupHidden(hidden: Hidden): { reason: string; items: Hidden }[] {
  const groups = new Map<string, Hidden>();
  for (const item of hidden) groups.set(item.reason, [...(groups.get(item.reason) ?? []), item]);
  return [...groups].map(([reason, items]) => ({ reason, items }));
}

export function eyesItem(item: LookHere, checks: CheckResult[]): FeedbackItem {
  const severity = checks.find((c) => c.id === item.checkId)?.severity;
  return {
    source: item.source ?? "check",
    ...(item.checkId ? { checkId: item.checkId } : {}),
    title: item.title,
    ...(severity ? { severity } : {}),
    ...(item.anchor ? { anchor: item.anchor } : {}),
    placement: "eyes",
    ...(item.fromNote ? { note: item.fromNote.id } : {}),
  };
}

export function findingItem(finding: LlmFinding): FeedbackItem {
  return {
    source: "llm",
    ...(finding.checkId ? { checkId: finding.checkId } : {}),
    title: finding.title,
    severity: finding.severity,
    ...(finding.anchors[0] ? { anchor: finding.anchors[0] } : {}),
    placement: "finding",
    ...(finding.fromNote ? { note: finding.fromNote.id } : {}),
  };
}

/** A model finding that came from one of your notes says so. */
export function FromNoteLine({ note }: { note: FromNote }) {
  return <span className="from-note">Because of your note: {note.text}</span>;
}

/**
 * After "Not useful" on a finding from one of your notes: stop applying the note to the finding's area, or edit the
 * note. Without either, the reaction is recorded and changes nothing.
 */
export function NoteOffer({
  item,
  note,
  feedback,
}: {
  item: FeedbackItem;
  note: FromNote;
  feedback: BriefingFeedback;
}) {
  const [state, setState] = useState<"ask" | "editing" | "stopped" | "edited">("ask");
  const [text, setText] = useState(note.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const change = feedback.changeNote;
  if (!change || feedback.verdictOf(item) !== "not_needed") return null;
  const area = item.anchor ? noteArea(item.anchor.path) : undefined;
  const run = async (next: typeof state, request: Parameters<typeof change>[0]) => {
    setBusy(true);
    setError(undefined);
    try {
      await change(request);
      setState(next);
    } catch (e) {
      setError(`Couldn't change the note: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset className="note-offer" aria-label="What to do with your note">
      {state === "ask" && (
        <>
          {area && <span>Stop applying this note to {area}?</span>}
          {area && (
            <button
              type="button"
              className="btn xs"
              disabled={busy}
              onClick={() => run("stopped", { action: "exclude", id: note.id, path: area })}
            >
              Stop applying
            </button>
          )}
          <button type="button" className="btn xs quiet" disabled={busy} onClick={() => setState("editing")}>
            Edit the note
          </button>
        </>
      )}
      {state === "editing" && (
        <form
          className="note-offer-edit"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void run("edited", { action: "edit", id: note.id, text: text.trim() });
          }}
        >
          <input
            className="input"
            aria-label="Edit your note"
            maxLength={500}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="btn xs" disabled={busy || !text.trim()}>
            Save
          </button>
          <button type="button" className="btn xs quiet" onClick={() => setState("ask")}>
            Cancel
          </button>
        </form>
      )}
      {state === "stopped" && area && (
        <>
          <span role="status">This note no longer applies under {area}.</span>
          <button
            type="button"
            className="btn xs quiet"
            disabled={busy}
            onClick={() => run("ask", { action: "include", id: note.id, path: area })}
          >
            Undo
          </button>
        </>
      )}
      {state === "edited" && <span role="status">Note updated. Reviews from now on use the new text.</span>}
      {error && (
        <span className="error-text" role="alert">
          {error}
        </span>
      )}
    </fieldset>
  );
}

function checkItem(check: CheckResult): FeedbackItem {
  return { source: "check", checkId: check.id, title: check.title, severity: check.severity, placement: "check" };
}

const NOTES: Record<Verdict, string> = {
  agree: "Noted. Alden will look for more like this.",
  not_needed: "Noted. Fewer like this here.",
  dismiss: "Dismissed for this PR",
};

/**
 * Useful, Not useful, or Dismiss, as quiet words that light up when chosen; pressing the chosen one again takes it
 * back. Under them, what the reaction taught Alden.
 */
export function Verdicts({ item, feedback }: { item: FeedbackItem; feedback: BriefingFeedback }) {
  const current = feedback.verdictOf(item);
  const button = (verdict: Verdict, label: string) => (
    <button
      type="button"
      className={`v3-react${current === verdict ? " on" : ""}`}
      aria-pressed={current === verdict}
      onClick={(e) => {
        e.stopPropagation();
        feedback.toggle(item, verdict);
      }}
    >
      {label}
    </button>
  );
  return (
    <fieldset className="verdicts v3-reacts" aria-label={`Was this worth a look? ${item.title}`}>
      {button("agree", "Useful")}
      {button("not_needed", "Not useful")}
      {button("dismiss", "Dismiss")}
      {current && (
        <span className="verdict-note" role="status">
          {current === "dismiss" ? NOTES[current] : (feedback.progressOf(item) ?? NOTES[current])}
        </span>
      )}
    </fieldset>
  );
}

/** The compact ↑ ↓ × for the model's other findings and for checks. */
function SmallVerdicts({
  item,
  feedback,
  dismiss = true,
}: {
  item: FeedbackItem;
  feedback: BriefingFeedback;
  dismiss?: boolean;
}) {
  const current = feedback.verdictOf(item);
  const progress = current && current !== "dismiss" ? feedback.progressOf(item) : undefined;
  const icon = (verdict: Verdict, glyph: string, label: string) => (
    <button
      type="button"
      className={`btn xs icon${current === verdict ? " on" : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={current === verdict}
      onClick={() => feedback.toggle(item, verdict)}
    >
      {glyph}
    </button>
  );
  return (
    <>
      {icon("agree", "↑", "Useful")}
      {icon("not_needed", "↓", "Not useful")}
      {dismiss && icon("dismiss", "×", "Dismiss")}
      {progress && (
        <span className="react-note" role="status">
          {progress}
        </span>
      )}
    </>
  );
}

/** "You missed something": what, and optionally where. */
function MissedForm({ feedback }: { feedback: BriefingFeedback }) {
  const [note, setNote] = useState("");
  const [where, setWhere] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!note.trim()) return;
    setSaving(true);
    try {
      const match = /^(.+?)(?::(\d+))?$/.exec(where.trim());
      const anchor = match?.[1]
        ? { path: match[1], ...(match[2] && Number(match[2]) > 0 ? { line: Number(match[2]) } : {}) }
        : undefined;
      await feedback.reportMissed(note.trim(), anchor);
      setNote("");
      setWhere("");
      setSaved(true);
    } catch {
      // the error shows above the form
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="section missed" aria-labelledby="missed-title">
      <div>
        <h2 className="h3" id="missed-title">
          You missed something
        </h2>
        <p className="muted small">
          Tell Alden what it should have caught. Saved on this machine only.
          {feedback.missedCount > 0 ? ` ${plural(feedback.missedCount, "miss", "misses")} reported here.` : ""}
        </p>
      </div>
      <form className="missed-form" onSubmit={submit}>
        <input
          className="input mono"
          aria-label="File and line (optional)"
          placeholder="file:line (optional)"
          value={where}
          onChange={(e) => setWhere(e.target.value)}
        />
        <input
          className="input"
          aria-label="What should it have flagged?"
          placeholder="What should it have flagged?"
          maxLength={2000}
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setSaved(false);
          }}
        />
        <button type="submit" className="btn" disabled={saving || !note.trim()}>
          {saving ? "Saving…" : "Save"}
        </button>
      </form>
      {saved && <p className="muted small">Recorded. It stays on this machine.</p>}
    </section>
  );
}

/** What the model's section says when it didn't run: over budget, failed, refused, skipped. */
function ModelState({ llm, perReviewUsd }: { llm: LlmSection; perReviewUsd?: number | undefined }) {
  if (llm.status === "ok") return null;
  const title =
    llm.status === "over_budget"
      ? perReviewUsd !== undefined
        ? `Stopped at your ${formatUsd(perReviewUsd)} cap`
        : "Stopped at your spend cap"
      : llm.status === "failed"
        ? "The model returned an error"
        : llm.status === "refused"
          ? "The model declined this one"
          : llm.status === "truncated"
            ? "The model's answer was cut off"
            : "Checks only";
  const tone = llm.status === "failed" ? "bad" : llm.status === "skipped" ? "neutral" : "warn";
  return (
    <div
      className="shaped"
      style={{ background: tone === "bad" ? "var(--bad-soft)" : tone === "warn" ? "var(--warn-soft)" : "var(--sunk)" }}
    >
      <span className="text">
        <strong>{title}.</strong> {llm.note} The checks below still apply.
      </span>
    </div>
  );
}

const MATCH: Record<NonNullable<LlmSection["matchesTitle"]>["verdict"], { text: string; tone: string }> = {
  yes: { text: "✓ matches its title", tone: "ok" },
  partly: { text: "partly matches its title", tone: "warn" },
  no: { text: "✕ doesn't match its title", tone: "bad" },
  unclear: { text: "no description to compare", tone: "neutral" },
};

/** A place's severity: its check's, or for one from the model, the finding's. */
export function severityOf(item: LookHere, briefing: Briefing): Severity | undefined {
  if (item.source === "llm" && briefing.llm?.status === "ok") {
    return briefing.llm.findings.find((f) => f.title === item.title)?.severity;
  }
  return briefing.checks.find((c) => c.id === item.checkId)?.severity;
}

/** "retry.py, models.py, worker.py and 3 more." */
function fileNames(paths: string[]): string {
  const names = paths.slice(0, 3).map((p) => p.split("/").pop() ?? p);
  const rest = paths.length - names.length;
  if (rest > 0) return `${names.join(", ")} and ${rest} more.`;
  if (names.length <= 1) return `${names.join("")}.`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}.`;
}

/**
 * One of the summary rows under the places to look: a label, a count and a line, opening to the whole section.
 */
function SummaryRow(props: {
  label: string;
  count: number;
  sum: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={`v3-row${props.open ? " open" : ""}`} aria-label={`${props.label} · ${props.count}`}>
      <h2 className="v3-row-h">
        <button
          type="button"
          className="v3-row-btn"
          aria-expanded={props.open}
          aria-controls={props.open ? id : undefined}
          onClick={props.onToggle}
        >
          <span className="v3-row-label">
            {props.label} <span className="v3-row-count">{props.count}</span>
          </span>
          <span className="v3-row-sum">{props.sum}</span>
          <span className="v3-row-chev" aria-hidden="true">
            ›
          </span>
        </button>
      </h2>
      {props.open && (
        <div id={id} className="v3-row-body">
          {props.children}
        </div>
      )}
    </section>
  );
}

type Row = "model" | "checks" | "notChecked" | "files";

/**
 * The brief, read in one direction: what the PR does, the few places that need your eyes (each opening to its code,
 * Comment and Walk through from here), then the model's other notes, the checks, what wasn't checked and the files as
 * four rows that open to their full sections, and in one line how your feedback shaped it. When the walk-through is
 * on (g, or Walk through), it takes the brief's place.
 */
export function BriefingView({
  briefing,
  feedback,
  perReviewUsd,
  comments: allComments,
  onComment: givenOnComment,
  guided,
}: {
  briefing: Briefing;
  feedback?: BriefingFeedback | undefined;
  perReviewUsd?: number | undefined;
  /** Comment from Alden: drafts for this PR, written here and sent as one review. Absent for local changes. */
  comments?: BriefingComments | undefined;
  /** Opens the Comments drawer's editor on a place; ReviewPane provides it (through context) on a PR. */
  onComment?: ((place: CommentPlace) => void) | undefined;
  /** The PR's diff, for the code at each place; Comment and Finish go to the Comments drawer unless given. */
  guided?: Pick<GuidedReviewProps, "loadDiff" | "onComment" | "onFinish"> | undefined;
}) {
  const actions = useReviewActions();
  const onComment = givenOnComment ?? actions?.onComment;
  const links = useAnchorLinks(briefing);
  const target = briefing.target;
  // Only on the PR the drafts belong to.
  const comments =
    target.kind === "pr" && allComments?.pr.toLowerCase() === `${target.repo}#${target.number}`.toLowerCase()
      ? allComments
      : undefined;
  /**
   * Your drafts on a place and its Comment: inline when the line is in the diff, otherwise (or for a whole file) a
   * note in the review body linking to it.
   */
  const slot = (anchor: Anchor | undefined, compact = false) => {
    if (!comments || !onComment || !anchor) return null;
    return <CommentSlot anchor={anchor} comments={comments} compact={compact} onComment={onComment} />;
  };
  /** `c` comments on the place you're on. */
  const placeOf = (anchor: Anchor | undefined) => {
    const place = withLine(anchor);
    return comments && onComment && place ? placeAttrs({ path: place.path, line: place.line, side: "RIGHT" }) : {};
  };
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(briefing.checks.filter((c) => c.status === "flagged").map((c) => [c.id, true])),
  );
  // The first place starts open, with its code.
  const [openEye, setOpenEye] = useState<Record<number, boolean>>({ 0: true });
  const [rows, setRows] = useState<Partial<Record<Row, boolean>>>({});
  const toggleRow = (row: Row) => setRows((r) => ({ ...r, [row]: !r[row] }));
  const [showHidden, setShowHidden] = useState(false);
  const key = guidedKey(briefing);
  const walk = useGuidedProgress(key);
  const anyOpen = briefing.needsYourEyes.some((_, i) => openEye[i]);
  const diff = useBriefingDiff(briefing, anyOpen && target.kind === "pr" ? guided?.loadDiff : undefined);
  const { llm } = briefing;
  const picked = new Set(briefing.needsYourEyes.flatMap((i) => (i.anchor ? [anchorKey(i.anchor)] : [])));
  const moreFindings: LlmFinding[] =
    llm?.status === "ok" ? llm.findings.filter((f) => !f.anchors.some((a) => picked.has(anchorKey(a)))) : [];

  if (briefing.files.length === 0) {
    return (
      <div className="state center">
        <Mark size={40} outline />
        <h2 className="title">Nothing has changed</h2>
        <p className="body">There's nothing to review.</p>
      </div>
    );
  }

  const counts = {
    passed: briefing.checks.filter((c) => c.status === "passed").length,
    flagged: briefing.checks.filter((c) => c.status === "flagged").length,
    skipped: briefing.checks.filter((c) => c.status === "skipped").length,
  };
  const hidden = briefing.learning?.hidden ?? [];
  const shapedBy = briefing.needsYourEyes
    .map((item, i) => (item.learned ? `#${i + 1} is here because ${lowerFirst(item.learned)}.` : ""))
    .filter(Boolean);
  const hiddenLines = groupHidden(hidden).map(
    ({ reason, items }) =>
      `${items.length === 1 ? "1 place is" : `${items.length} places are`} hidden: ${lowerFirst(reason)}.`,
  );
  const memory = briefing.learning?.memory ?? 0;
  const heuristic = new Set(briefing.checks.filter((c) => c.heuristic).map((c) => c.id));
  const quietened = new Map((briefing.learning?.quietened ?? []).map((q) => [q.checkId, q.reason]));
  const quietTitles = briefing.checks.filter((c) => quietened.has(c.id)).map((c) => c.title);
  const quietLine =
    quietTitles.length > 0 ? `${quietTitles.join(", ")} ${quietTitles.length === 1 ? "is" : "are"} quietened.` : "";
  const memoryLine =
    memory > 0 ? `The model had ${plural(memory, "of your notes", "of your notes")} for this repo.` : "";
  const shaped = [...shapedBy, ...hiddenLines, quietLine, memoryLine].filter(Boolean);
  const totalLines = Math.max(...briefing.files.map((f) => f.additions + f.deletions), 1);
  const places = briefing.needsYourEyes.length;
  const canWalk = guidedSteps(briefing).steps.length > 0;

  // The model also noticed: its first finding in a line, why it's there, and whether a draft is waiting.
  const firstFinding = moreFindings[0];
  const draftsReady = moreFindings.filter((f) =>
    comments?.drafts.some((d) => d.source === "alden" && d.drafted?.title === f.title),
  ).length;
  const modelSum = firstFinding
    ? [
        firstFinding.fromNote ? `Because of your note on ${firstFinding.fromNote.text}: ` : "",
        `${lowerFirst(firstFinding.title)}`,
        moreFindings.length > 1 ? `, and ${moreFindings.length - 1} more` : "",
        draftsReady > 0 ? `. ${draftsReady === 1 ? "A draft is ready" : `${draftsReady} drafts are ready`}.` : ".",
      ]
        .join("")
        .replace(/^./, (c) => c.toUpperCase())
    : "";
  const checksSum = [
    `${counts.passed} passed`,
    counts.flagged > 0 ? `${counts.flagged} flagged` : "",
    counts.skipped > 0 ? `${counts.skipped} skipped` : "",
  ]
    .filter(Boolean)
    .join(", ");

  const brief = (
    <article className="brief-body v3-brief">
      {llm?.status === "ok" && llm.summary && (
        <section className="v3-does" aria-labelledby="what-it-does">
          <div className="v3-does-head">
            <h2 className="v3-label" id="what-it-does">
              What it does
            </h2>
            {llm.matchesTitle && (
              <span className={`v3-match ${MATCH[llm.matchesTitle.verdict].tone}`} title={llm.matchesTitle.reason}>
                {MATCH[llm.matchesTitle.verdict].text}
              </span>
            )}
          </div>
          <p className="v3-does-text">{llm.summary}</p>
        </section>
      )}
      {llm && llm.status !== "ok" && <ModelState llm={llm} perReviewUsd={perReviewUsd} />}

      <section className="v3-eyes" aria-labelledby="needs-your-eyes">
        <div className="v3-eyes-head">
          <h2 className="v3-h" id="needs-your-eyes">
            Needs your eyes
          </h2>
          <span className="v3-count">{plural(places, "place")}</span>
        </div>
        {places === 0 ? (
          <p className="muted">
            {llm?.status === "ok"
              ? "Nothing flagged. Neither the checks nor the model found anything that needs a closer look."
              : "Nothing flagged. The checks below found nothing that needs a closer look."}
          </p>
        ) : (
          <ol className="visually-plain v3-cards">
            {briefing.needsYourEyes.map((item, i) => {
              const fbItem = eyesItem(item, briefing.checks);
              const verdict = feedback?.verdictOf(fbItem);
              const guess = item.source !== "llm" && item.checkId !== undefined && heuristic.has(item.checkId);
              const severity = severityOf(item, briefing);
              const isOpen = !!openEye[i];
              const bodyId = `${key}-eye-${i}`;
              const toggle = () => setOpenEye((o) => ({ ...o, [i]: !o[i] }));
              const anchor = item.anchor;
              const file =
                diff.state === "ok" && anchor ? diff.diff.files.find((f) => f.path === anchor.path) : undefined;
              const excerpt = anchor ? excerptAround(file, anchor.line, 3) : undefined;
              return (
                <li
                  key={`${item.title}${anchor ? anchorKey(anchor) : ""}`}
                  {...placeOf(anchor)}
                  className={`v3-card${isOpen ? " open" : ""}${guess ? " guess" : ""}${verdict === "agree" ? " agreed" : ""}${verdict === "dismiss" ? " dismissed" : ""}`}
                >
                  {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: a bigger target for the mouse; the +/− button is the control. */}
                  <div
                    className="v3-card-head"
                    onClick={(e) => !(e.target as Element).closest("a, button") && toggle()}
                  >
                    <div className="v3-ids">
                      <span className="v3-id">E{i + 1}</span>
                      {severity && <span className={`v3-sev ${severity}`}>{SEVERITY[severity]}</span>}
                      {anchor && <Place anchor={anchor} links={links} arrow />}
                      <button
                        type="button"
                        className="v3-chev"
                        aria-expanded={isOpen}
                        aria-controls={isOpen ? bodyId : undefined}
                        aria-label={`${isOpen ? "Hide" : "Show"} the code for E${i + 1}`}
                        onClick={toggle}
                      >
                        {isOpen ? "−" : "+"}
                      </button>
                    </div>
                    <p className="v3-why">
                      <strong>{item.title}.</strong> {item.reason}
                      {item.source === "llm" && <span className="v3-tag">model</span>}
                      {item.source === "llm" && <DraftReady title={item.title} comments={comments} />}
                    </p>
                    {guess && (
                      <span className="guess-line">
                        <span className="q" aria-hidden="true">
                          ?
                        </span>
                        Inferred from the diff, so it can be wrong.
                      </span>
                    )}
                    {item.learned && <span className="learned-why">↑ {item.learned}</span>}
                    {item.fromNote && <FromNoteLine note={item.fromNote} />}
                  </div>
                  {isOpen && (
                    <div id={bodyId} className="v3-card-body">
                      {anchor && target.kind === "pr" && guided?.loadDiff && (
                        <div className="v3-card-code">
                          <CodeAt path={anchor.path} excerpt={excerpt} diff={diff} url={links.get(anchorKey(anchor))} />
                        </div>
                      )}
                      <div className="v3-card-acts">
                        {slot(anchor)}
                        {canWalk && (
                          <button type="button" className="v3-text-btn" onClick={() => startGuided(key, i)}>
                            Walk through from here
                          </button>
                        )}
                        {feedback && <Verdicts item={fbItem} feedback={feedback} />}
                      </div>
                      {feedback && item.fromNote && (
                        <NoteOffer item={fbItem} note={item.fromNote} feedback={feedback} />
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {canWalk && (
          <button
            type="button"
            className="v3-walk-start"
            data-walk-start=""
            aria-keyshortcuts="g"
            onClick={() => startGuided(key)}
          >
            {walk.step > 0
              ? `Resume the walk-through at step ${walk.step + 1}`
              : places > 0
                ? `Walk through ${places === 1 ? "this place" : `these ${places} places`}`
                : "Walk through the model's findings"}{" "}
            <kbd>g</kbd>
          </button>
        )}
      </section>

      <div className="v3-rows">
        {moreFindings.length > 0 && (
          <SummaryRow
            label="The model also noticed"
            count={moreFindings.length}
            sum={modelSum}
            open={!!rows.model}
            onToggle={() => toggleRow("model")}
          >
            <ul className="visually-plain v3-findings">
              {moreFindings.map((f) => {
                const verdict = feedback?.verdictOf(findingItem(f));
                return (
                  <li
                    key={`${f.title}${f.anchors.map(anchorKey).join()}`}
                    className={`finding${verdict === "dismiss" ? " dismissed" : ""}`}
                  >
                    <div className="what">
                      <span>
                        <strong>{f.title}.</strong> <span className="muted">{f.detail}</span>
                        <DraftReady title={f.title} comments={comments} />
                      </span>
                      {f.fromNote && <FromNoteLine note={f.fromNote} />}
                      {feedback && f.fromNote && (
                        <NoteOffer item={findingItem(f)} note={f.fromNote} feedback={feedback} />
                      )}
                      {f.anchors.map((a) => (
                        <Place key={anchorKey(a)} anchor={a} links={links} />
                      ))}
                      {slot(f.anchors[0])}
                    </div>
                    <div className="acts">
                      <span className={`v3-sev ${f.severity}`}>{SEVERITY[f.severity]}</span>
                      {feedback && <SmallVerdicts item={findingItem(f)} feedback={feedback} />}
                    </div>
                  </li>
                );
              })}
            </ul>
            {llm?.status === "ok" && llm.draftsNote && <p className="v3-quiet-line">{llm.draftsNote}</p>}
          </SummaryRow>
        )}

        <SummaryRow
          label="Checks"
          count={briefing.checks.length}
          sum={`${checksSum}.${quietTitles.length > 0 ? ` ${quietTitles.join(", ")} quietened for this repo.` : ""}`}
          open={!!rows.checks}
          onToggle={() => toggleRow("checks")}
        >
          <span className="checks-count">
            <span className="ok-text">✓ {counts.passed} passed</span>
            <span style={{ color: "var(--warn)" }}>! {counts.flagged} flagged</span>
            <span className="faint">– {counts.skipped} skipped</span>
            {hidden.length > 0 && (
              <button type="button" className="link-button faint mono" onClick={() => setShowHidden((v) => !v)}>
                {hidden.length} hidden by your feedback · {showHidden ? "hide" : "show"}
              </button>
            )}
          </span>
          {showHidden && (
            <ul className="note-box visually-plain" aria-label="Hidden by your feedback">
              {hidden.map((h) => (
                <li key={`${h.title}${h.anchor ? anchorKey(h.anchor) : ""}`}>
                  <strong>{h.title}</strong> · {h.reason}
                </li>
              ))}
            </ul>
          )}
          <div className="card checks">
            {briefing.checks.map((check) => {
              const isOpen = !!open[check.id];
              const status = STATUS[check.status];
              const canOpen = check.evidence.length > 0 || check.status === "flagged";
              const quiet = quietened.get(check.id);
              return (
                <div key={check.id} className="check">
                  <button
                    type="button"
                    className="check-row"
                    aria-expanded={canOpen ? isOpen : undefined}
                    disabled={!canOpen}
                    onClick={() => setOpen((o) => ({ ...o, [check.id]: !o[check.id] }))}
                  >
                    <span className={`dot ${check.status}`} aria-hidden="true">
                      {status.glyph}
                    </span>
                    <span
                      className="check-name"
                      style={{ color: check.status === "skipped" ? "var(--ink2)" : undefined }}
                    >
                      {check.title}
                      {check.heuristic && (
                        <span className="faint" title="Inferred from the diff and the code graph, so it can be wrong">
                          {" "}
                          ~
                        </span>
                      )}
                    </span>
                    <span className={`sev${check.status === "flagged" ? ` ${check.severity}` : ""}`}>
                      {check.status === "flagged" ? SEVERITY[check.severity] : "—"}
                    </span>
                    <span className={`status ${check.status}`} title={quiet ? upperFirst(quiet) : undefined}>
                      {quiet ? "Quietened" : status.label} {canOpen ? (isOpen ? "▾" : "▸") : ""}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="check-detail">
                      <span className="muted small" style={{ fontSize: 13 }}>
                        {check.summary}
                      </span>
                      {quiet && <span className="learned-why">↓ {upperFirst(quiet)}</span>}
                      {check.evidence.length > 0 && (
                        <ul className="evidence">
                          {check.evidence.map((e) => {
                            const commentable = !!(comments && onComment && e.anchor);
                            return (
                              <li
                                key={`${e.text}${e.anchor ? anchorKey(e.anchor) : ""}`}
                                {...placeOf(e.anchor)}
                                className={commentable ? "commentable" : undefined}
                              >
                                {e.anchor && <Place anchor={e.anchor} links={links} />}
                                <span className="text">{e.text}</span>
                                {slot(e.anchor, true)}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      {check.status === "flagged" && feedback && (
                        <div className="verdicts">
                          <span className="faint small">Worth flagging?</span>
                          <CheckVerdicts check={check} feedback={feedback} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {briefing.checks.some((c) => c.heuristic) && (
            <p className="faint small">~ inferred from the diff and the code graph, so it can be wrong.</p>
          )}
        </SummaryRow>

        {briefing.notChecked.length > 0 && (
          <SummaryRow
            label="Not checked"
            count={briefing.notChecked.length}
            sum={`${briefing.notChecked[0]}${briefing.notChecked.length > 1 ? ` And ${briefing.notChecked.length - 1} more.` : ""}`}
            open={!!rows.notChecked}
            onToggle={() => toggleRow("notChecked")}
          >
            <ul className="not-checked">
              {briefing.notChecked.map((n) => (
                <li key={n}>
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          </SummaryRow>
        )}

        <SummaryRow
          label="Files changed"
          count={briefing.summary.files}
          sum={fileNames(briefing.files.map((f) => f.path))}
          open={!!rows.files}
          onToggle={() => toggleRow("files")}
        >
          <ul className="card files">
            {briefing.files.map((f) => {
              const total = f.additions + f.deletions;
              const scale = Math.min(1, total / Math.min(totalLines, 60)) * 100;
              return (
                <li key={f.path} className="file">
                  <span className="path" title={f.previousPath ? `${f.path}, moved from ${f.previousPath}` : f.path}>
                    <Place anchor={{ path: f.path }} links={links} />
                    {f.previousPath && <span className="moved faint small">moved from {f.previousPath}</span>}
                  </span>
                  <span>
                    <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
                  </span>
                  <span className="bar" aria-hidden="true">
                    <span className="a" style={{ width: `${total ? (f.additions / total) * scale : 0}%` }} />
                    <span className="d" style={{ width: `${total ? (f.deletions / total) * scale : 0}%` }} />
                  </span>
                </li>
              );
            })}
          </ul>
        </SummaryRow>
      </div>

      {shaped.length > 0 && (
        <p className="v3-shaped">
          <span className="v3-shaped-mark" aria-hidden="true">
            ◦
          </span>
          <span>
            Shaped by your feedback: {shaped.join(" ")}{" "}
            <a href={routePath({ view: "memory" })} onClick={onLinkClick({ view: "memory" })}>
              What Alden knows
            </a>
          </span>
        </p>
      )}

      <Footer briefing={briefing} perReviewUsd={perReviewUsd} />

      {feedback?.error && <p className="banner error">{feedback.error}</p>}
      {feedback && <MissedForm feedback={feedback} />}
    </article>
  );

  return (
    <GuidedReview
      briefing={briefing}
      feedback={feedback}
      loadDiff={guided?.loadDiff}
      onComment={guided?.onComment ?? onComment}
      onFinish={guided?.onFinish ?? actions?.onFinish}
    >
      {brief}
    </GuidedReview>
  );
}

function CheckVerdicts({ check, feedback }: { check: CheckResult; feedback: BriefingFeedback }) {
  const item = checkItem(check);
  const current = feedback.verdictOf(item);
  const notes: Partial<Record<Verdict, string>> = {
    agree: "Noted. Alden will look for more like this.",
    not_needed: "Noted. Fewer like this here.",
  };
  return (
    <>
      <button
        type="button"
        className={`btn xs${current === "agree" ? " on" : ""}`}
        aria-pressed={current === "agree"}
        onClick={() => feedback.toggle(item, "agree")}
      >
        ↑ Useful
      </button>
      <button
        type="button"
        className={`btn xs${current === "not_needed" ? " on" : ""}`}
        aria-pressed={current === "not_needed"}
        onClick={() => feedback.toggle(item, "not_needed")}
      >
        ↓ Not useful
      </button>
      {current && <span className="react-note">{feedback.progressOf(item) ?? notes[current]}</span>}
    </>
  );
}

function Footer({ briefing, perReviewUsd }: { briefing: Briefing; perReviewUsd?: number | undefined }) {
  const { llm } = briefing;
  const time = new Date(briefing.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const parts: string[] = [];
  if (llm?.status === "ok") {
    parts.push(llm.model ?? "unknown model");
    if (llm.effort) parts.push(`effort ${llm.effort}`);
    parts.push(
      llm.usd === undefined
        ? "cost unknown"
        : perReviewUsd !== undefined
          ? `${formatUsd(llm.usd)} of ${formatUsd(perReviewUsd)}`
          : formatUsd(llm.usd),
    );
    if (llm.droppedFindings > 0)
      parts.push(`${plural(llm.droppedFindings, "finding")} dropped for pointing outside the diff`);
    if (llm.redactedSecrets) parts.push(`${plural(llm.redactedSecrets, "secret")} hidden before sending`);
    if (llm.omittedFiles.length > 0)
      parts.push(`${plural(llm.omittedFiles.length, "file")} left out to fit the budget`);
    if (llm.draftsNote) parts.push(llm.draftsNote);
  } else {
    parts.push("checks only, no model");
  }
  return (
    <footer className="brief-footer">
      {parts.map((p) => (
        <span key={p}>{p}</span>
      ))}
      <span className="end">briefed {time}</span>
    </footer>
  );
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const upperFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
