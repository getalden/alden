import type {
  Anchor,
  Briefing,
  CheckResult,
  FeedbackItem,
  LlmFinding,
  LlmSection,
  LookHere,
  Severity,
} from "@alden/schema";
import { type FormEvent, useEffect, useState } from "react";
import type { BriefingFeedback, Verdict } from "../feedback";
import { formatUsd, plural, prFileUrl } from "../format";
import { onLinkClick, routePath } from "../router";
import { Mark } from "./Mark";

const anchorKey = (a: Anchor) => `${a.path}:${a.line ?? ""}`;

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
  return href ? (
    <a className="place" href={href} target="_blank" rel="noreferrer">
      {text}
      {arrow ? " ↗" : ""}
    </a>
  ) : (
    <span className="place">{text}</span>
  );
}

const SEVERITY: Record<Severity, string> = { critical: "critical", high: "high", medium: "med", low: "low", info: "—" };
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

function eyesItem(item: LookHere, checks: CheckResult[]): FeedbackItem {
  const severity = checks.find((c) => c.id === item.checkId)?.severity;
  return {
    source: item.source ?? "check",
    ...(item.checkId ? { checkId: item.checkId } : {}),
    title: item.title,
    ...(severity ? { severity } : {}),
    ...(item.anchor ? { anchor: item.anchor } : {}),
    placement: "eyes",
  };
}

function findingItem(finding: LlmFinding): FeedbackItem {
  return {
    source: "llm",
    ...(finding.checkId ? { checkId: finding.checkId } : {}),
    title: finding.title,
    severity: finding.severity,
    ...(finding.anchors[0] ? { anchor: finding.anchors[0] } : {}),
    placement: "finding",
  };
}

function checkItem(check: CheckResult): FeedbackItem {
  return { source: "check", checkId: check.id, title: check.title, severity: check.severity, placement: "check" };
}

const NOTES: Record<Verdict, string> = {
  agree: "Noted. Alden will look for more like this.",
  not_needed: "Noted. Fewer like this here.",
  dismiss: "Dismissed for this PR",
};

/** Useful, not useful, or dismiss. Pressing the chosen one again takes it back. */
function Verdicts({ item, feedback }: { item: FeedbackItem; feedback: BriefingFeedback }) {
  const current = feedback.verdictOf(item);
  const button = (verdict: Verdict, label: string, onLabel: string, className = "") => (
    <button
      type="button"
      className={`btn sm ${className}${current === verdict ? (verdict === "agree" ? " on" : " on neutral") : ""}`}
      aria-pressed={current === verdict}
      onClick={() => feedback.toggle(item, verdict)}
    >
      {current === verdict ? onLabel : label}
    </button>
  );
  return (
    <fieldset className="verdicts" aria-label={`Was this worth a look? ${item.title}`}>
      {button("agree", "Useful", "✓ Useful")}
      {button("not_needed", "Not useful", "✓ Not useful")}
      {button("dismiss", "× Dismiss", "Undo", "quiet")}
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
  yes: { text: "✓ Matches its title", tone: "" },
  partly: { text: "Partly matches its title", tone: "warn" },
  no: { text: "✕ Doesn't match its title", tone: "bad" },
  unclear: { text: "No description to compare", tone: "neutral" },
};

/**
 * The briefing, in the order a reviewer reads it: what it does, the few places that need your eyes (and how your
 * feedback shaped them), the model's other notes, every check with evidence, what wasn't checked, the files.
 */
export function BriefingView({
  briefing,
  feedback,
  perReviewUsd,
}: {
  briefing: Briefing;
  feedback?: BriefingFeedback | undefined;
  perReviewUsd?: number | undefined;
}) {
  const links = useAnchorLinks(briefing);
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(briefing.checks.filter((c) => c.status === "flagged").map((c) => [c.id, true])),
  );
  const [showHidden, setShowHidden] = useState(false);
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
  const shaped = shapedBy.length > 0 || hiddenLines.length > 0 || memory > 0;
  const heuristic = new Set(briefing.checks.filter((c) => c.heuristic).map((c) => c.id));
  const quietened = new Map((briefing.learning?.quietened ?? []).map((q) => [q.checkId, q.reason]));
  const totalLines = Math.max(...briefing.files.map((f) => f.additions + f.deletions), 1);

  return (
    <article className="brief-body">
      {llm?.status === "ok" && llm.summary && (
        <section className="section" aria-labelledby="what-it-does" style={{ gap: 10 }}>
          <div className="section-head" style={{ justifyContent: "flex-start", gap: 10 }}>
            <h2 className="label" id="what-it-does">
              What it does
            </h2>
            {llm.matchesTitle && (
              <span className={`pill ${MATCH[llm.matchesTitle.verdict].tone}`} title={llm.matchesTitle.reason}>
                {MATCH[llm.matchesTitle.verdict].text}
              </span>
            )}
          </div>
          <p className="summary-text">{llm.summary}</p>
        </section>
      )}
      {llm && llm.status !== "ok" && <ModelState llm={llm} perReviewUsd={perReviewUsd} />}

      <section className="section" aria-labelledby="needs-your-eyes">
        <div className="section-head">
          <h2 className="h2" id="needs-your-eyes">
            Needs your eyes
          </h2>
          <span className="faint small mono">{plural(briefing.needsYourEyes.length, "place")}</span>
        </div>
        {shaped && (
          <div className="shaped">
            <Mark size={16} />
            <span className="text">
              <strong>Shaped by your feedback.</strong> {[...shapedBy, ...hiddenLines].join(" ")}
              {memory > 0 && ` The model had ${plural(memory, "of your notes", "of your notes")} for this repo.`}
            </span>
            <a href={routePath({ view: "memory" })} onClick={onLinkClick({ view: "memory" })}>
              What Alden knows ↗
            </a>
          </div>
        )}
        {briefing.needsYourEyes.length === 0 ? (
          <p className="muted">
            {llm?.status === "ok"
              ? "Nothing flagged. Neither the checks nor the model found anything that needs a closer look."
              : "Nothing flagged. The checks below found nothing that needs a closer look."}
          </p>
        ) : (
          <ol className="visually-plain section" style={{ gap: 12 }}>
            {briefing.needsYourEyes.map((item, i) => {
              const fbItem = eyesItem(item, briefing.checks);
              const verdict = feedback?.verdictOf(fbItem);
              const guess = item.source !== "llm" && item.checkId !== undefined && heuristic.has(item.checkId);
              return (
                <li
                  key={`${item.title}${item.anchor ? anchorKey(item.anchor) : ""}`}
                  className={`card eye${guess ? " guess" : ""}${verdict === "agree" ? " agreed" : ""}${verdict === "dismiss" ? " dismissed" : ""}`}
                >
                  <span className="eye-n">{i + 1}</span>
                  <div className="eye-body">
                    {item.anchor && <Place anchor={item.anchor} links={links} arrow />}
                    <p className="eye-text">
                      <strong>{item.title}.</strong> {item.reason}
                      {item.source === "llm" && (
                        <span className="chip" style={{ marginLeft: 6 }}>
                          model
                        </span>
                      )}
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
                    {feedback && <Verdicts item={fbItem} feedback={feedback} />}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {moreFindings.length > 0 && (
        <section className="section" aria-labelledby="also-noted" style={{ gap: 10 }}>
          <h2 className="label" id="also-noted">
            The model also noticed · {moreFindings.length}
          </h2>
          <ul className="visually-plain">
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
                    </span>
                    {f.anchors.map((a) => (
                      <Place key={anchorKey(a)} anchor={a} links={links} />
                    ))}
                  </div>
                  <div className="acts">
                    <span className={`sev ${f.severity}`}>{SEVERITY[f.severity]}</span>
                    {feedback && <SmallVerdicts item={findingItem(f)} feedback={feedback} />}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="section" aria-labelledby="checks">
        <div className="section-head">
          <h2 className="h2" id="checks">
            Checks
          </h2>
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
        </div>
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
                        {check.evidence.map((e) => (
                          <li key={`${e.text}${e.anchor ? anchorKey(e.anchor) : ""}`}>
                            {e.anchor && <Place anchor={e.anchor} links={links} />}
                            <span className="text">{e.text}</span>
                          </li>
                        ))}
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
      </section>

      {briefing.notChecked.length > 0 && (
        <section className="section" aria-labelledby="not-checked" style={{ gap: 10 }}>
          <h2 className="label" id="not-checked">
            Not checked
          </h2>
          <ul className="not-checked">
            {briefing.notChecked.map((n) => (
              <li key={n}>
                <span>{n}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="section" aria-labelledby="files" style={{ gap: 10 }}>
        <h2 className="label" id="files">
          Files changed · {briefing.summary.files}
        </h2>
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
      </section>

      <Footer briefing={briefing} perReviewUsd={perReviewUsd} />

      {feedback?.error && <p className="banner error">{feedback.error}</p>}
      {feedback && <MissedForm feedback={feedback} />}
    </article>
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
