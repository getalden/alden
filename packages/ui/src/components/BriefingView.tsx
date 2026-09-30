import type { Anchor, Briefing, CheckResult, LlmFinding, LlmSection, Severity } from "@alden/schema";
import { useEffect, useState } from "react";
import { formatUsd, plural, prFileUrl } from "../format";

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

function Place({ anchor, links }: { anchor: Anchor; links: Map<string, string> }) {
  const text = `${anchor.path}${anchor.line ? `:${anchor.line}` : ""}`;
  const href = links.get(anchorKey(anchor));
  return href ? (
    <a className="place mono" href={href} target="_blank" rel="noreferrer">
      {text}
    </a>
  ) : (
    <span className="place mono">{text}</span>
  );
}

const SEVERITY_LABEL: Record<Severity, string> = { high: "High", medium: "Medium", low: "Low", info: "" };

function SeverityBadge({ severity }: { severity: Severity }) {
  return severity === "info" ? null : <span className={`badge ${severity}`}>{SEVERITY_LABEL[severity]}</span>;
}

const STATUS_ICON: Record<CheckResult["status"], { icon: string; label: string }> = {
  passed: { icon: "✓", label: "Passed" },
  flagged: { icon: "!", label: "Flagged" },
  skipped: { icon: "–", label: "Skipped" },
};

/** The briefing, in the same order as the CLI: where to look, what the change does, what was checked, what wasn't. */
export function BriefingView({ briefing }: { briefing: Briefing }) {
  const links = useAnchorLinks(briefing);
  const { llm } = briefing;
  const picked = new Set(briefing.needsYourEyes.flatMap((i) => (i.anchor ? [anchorKey(i.anchor)] : [])));
  const moreFindings: LlmFinding[] =
    llm?.status === "ok" ? llm.findings.filter((f) => !f.anchors.some((a) => picked.has(anchorKey(a)))) : [];

  if (briefing.files.length === 0) {
    return (
      <div className="state">
        <h2>Nothing has changed</h2>
        <p>There's nothing to review.</p>
      </div>
    );
  }

  return (
    <article className="briefing">
      {llm?.status === "ok" && llm.summary && (
        <section className="card" aria-labelledby="what-it-does">
          <h2 id="what-it-does">What it does</h2>
          <p>{llm.summary}</p>
          {llm.matchesTitle && (
            <p className="muted">
              Matches its title: <strong>{llm.matchesTitle.verdict}</strong> · {llm.matchesTitle.reason}
            </p>
          )}
        </section>
      )}

      <section aria-labelledby="needs-your-eyes">
        <h2 id="needs-your-eyes" className="section-title">
          Needs your eyes
        </h2>
        {briefing.needsYourEyes.length === 0 ? (
          <p className="muted">
            {llm?.status === "ok"
              ? "Nothing flagged. Neither the checks nor the model found anything that needs a closer look."
              : "Nothing flagged. The checks below found nothing that needs a closer look."}
          </p>
        ) : (
          <ol className="eyes">
            {briefing.needsYourEyes.map((item) => (
              <li key={`${item.title}${item.anchor ? anchorKey(item.anchor) : ""}`} className="card eye">
                <div className="eye-head">
                  <strong>{item.title}</strong>
                  {item.source === "llm" && <span className="badge accent">model</span>}
                </div>
                {item.anchor && <Place anchor={item.anchor} links={links} />}
                <p className="muted">{item.reason}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      {moreFindings.length > 0 && (
        <section aria-labelledby="also-noted">
          <h2 id="also-noted" className="section-title">
            Also noted by the model
          </h2>
          <ul className="plain-list">
            {moreFindings.map((f) => (
              <li key={`${f.title}${f.anchors.map(anchorKey).join()}`} className="finding">
                <div className="eye-head">
                  <SeverityBadge severity={f.severity} />
                  <strong>{f.title}</strong>
                </div>
                <div className="places">
                  {f.anchors.map((a) => (
                    <Place key={anchorKey(a)} anchor={a} links={links} />
                  ))}
                </div>
                <p className="muted">{f.detail}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="checked">
        <h2 id="checked" className="section-title">
          Checked
        </h2>
        <ul className="checks">
          {briefing.checks.map((check) => (
            <li key={check.id} className="check-item">
              <CheckRow check={check} links={links} />
            </li>
          ))}
        </ul>
        {briefing.checks.some((c) => c.heuristic) && (
          <p className="faint small">~ inferred from the diff and the code graph, so it can be wrong.</p>
        )}
      </section>

      {briefing.notChecked.length > 0 && (
        <section aria-labelledby="not-checked">
          <h2 id="not-checked" className="section-title">
            Not checked
          </h2>
          <ul className="bullets muted">
            {briefing.notChecked.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </section>
      )}

      <details className="files">
        <summary className="section-title">
          {plural(briefing.summary.files, "file")} changed{" "}
          <span className="size mono">
            <span className="add">+{briefing.summary.additions}</span>{" "}
            <span className="del">−{briefing.summary.deletions}</span>
          </span>
        </summary>
        <ul className="plain-list file-list">
          {briefing.files.map((f) => (
            <li key={f.path} className="file-item">
              <Place anchor={{ path: f.path }} links={links} />
              <span className="faint">
                {f.status !== "modified" ? `${f.status} · ` : ""}
                {f.kind}
              </span>
              <span className="size mono">
                <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
              </span>
            </li>
          ))}
        </ul>
      </details>

      {llm && <ModelFooter llm={llm} />}
    </article>
  );
}

function CheckRow({ check, links }: { check: CheckResult; links: Map<string, string> }) {
  const status = STATUS_ICON[check.status];
  const head = (
    <>
      <span className={`check-icon ${check.status}`} role="img" aria-label={status.label}>
        {status.icon}
      </span>
      <span className="check-title">
        {check.title}
        {check.heuristic && (
          <span className="faint" title="Inferred from the diff and the code graph, so it can be wrong">
            {" "}
            ~
          </span>
        )}
      </span>
      <SeverityBadge severity={check.status === "flagged" ? check.severity : "info"} />
      <span className="check-summary muted">{check.summary}</span>
    </>
  );
  if (check.evidence.length === 0) return <div className="check">{head}</div>;
  return (
    <details className="check" open={check.status === "flagged"}>
      <summary>{head}</summary>
      <ul className="evidence">
        {check.evidence.map((e) => (
          <li key={`${e.text}${e.anchor ? anchorKey(e.anchor) : ""}`} className="evidence-item">
            {e.anchor && <Place anchor={e.anchor} links={links} />}
            <span>{e.text}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ModelFooter({ llm }: { llm: LlmSection }) {
  if (llm.status !== "ok") {
    const label = llm.status === "skipped" ? "Model not used" : `Model ${llm.status.replace("_", " ")}`;
    return (
      <p className="footer muted">
        <strong>{label}.</strong> {llm.note}
      </p>
    );
  }
  const parts = [
    `${llm.model ?? "unknown model"}${llm.provider ? ` via ${llm.provider}` : ""}${llm.effort ? ` · effort ${llm.effort}` : ""}`,
    llm.usd === undefined ? "cost unknown" : formatUsd(llm.usd),
    llm.droppedFindings > 0 &&
      `${plural(llm.droppedFindings, "finding")} dropped for pointing at lines not in the diff`,
    llm.redactedSecrets && `${plural(llm.redactedSecrets, "likely secret")} hidden from the model`,
    llm.omittedFiles.length > 0 && `${plural(llm.omittedFiles.length, "file")} left out to fit the budget`,
  ].filter(Boolean);
  return <p className="footer faint">{parts.join(" · ")}</p>;
}
