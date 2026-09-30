import type { FeedbackSummary } from "@alden/schema";
import { type FormEvent, useEffect, useState } from "react";
import type { Api, Session, SpendReport } from "../api";
import { formatUsd, plural } from "../format";

/** Defaults for every review (saved to your user config, like `alden config set`) and what you've spent. */
export function SettingsView({ api, session, onSaved }: { api: Api; session: Session; onSaved: () => void }) {
  const [spend, setSpend] = useState<SpendReport>();
  const [feedback, setFeedback] = useState<FeedbackSummary>();
  const [model, setModel] = useState(session.model.name);
  const [effort, setEffort] = useState(session.model.effort ?? "");
  const [perReview, setPerReview] = useState(String(session.budget.perReviewUsd));
  const [daily, setDaily] = useState(String(session.budget.dailyUsd));
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string }>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.spend().then(setSpend, () => setSpend(undefined));
    api.feedbackSummary().then(setFeedback, () => setFeedback(undefined));
  }, [api]);

  const models =
    session.model.provider === "openai-compatible"
      ? [session.model.name]
      : [...new Set([session.model.name, ...Object.keys(session.aliases)])];

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setStatus(undefined);
    const changes: [string, string | null][] = [];
    if (model !== session.model.name) changes.push(["model.name", model]);
    if (effort !== (session.model.effort ?? "")) changes.push(["model.effort", effort || null]);
    if (Number(perReview) !== session.budget.perReviewUsd) changes.push(["budget.perReviewUsd", perReview]);
    if (Number(daily) !== session.budget.dailyUsd) changes.push(["budget.dailyUsd", daily]);
    try {
      for (const [key, value] of changes) await api.setConfig(key, value);
      setStatus({ tone: "ok", text: changes.length > 0 ? "Saved to your user config." : "Nothing changed." });
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: (error as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings" aria-labelledby="settings-title">
      <h1 id="settings-title">Settings</h1>

      <form className="card form" onSubmit={save}>
        <h2>Model</h2>
        <p className="muted small">
          {session.model.available ? (
            <>
              Using <span className="mono">{session.model.id}</span> via {session.model.provider}.
            </>
          ) : (
            session.model.reason
          )}
        </p>
        <div className="form-grid">
          <label>
            Default model
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label>
            Default effort
            <select value={effort} onChange={(e) => setEffort(e.target.value)}>
              <option value="">The model's own (high)</option>
              {session.efforts.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>
          <label>
            Cap per review (USD)
            <input type="text" inputMode="decimal" value={perReview} onChange={(e) => setPerReview(e.target.value)} />
          </label>
          <label>
            Cap per day (USD)
            <input type="text" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} />
          </label>
        </div>
        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          {status && <span className={status.tone === "error" ? "error-text" : "muted"}>{status.text}</span>}
        </div>
        <p className="faint small">
          Changes go to your user config, like <code>alden config set</code>. A repo's <code>.alden.toml</code> still
          overrides them there. Providers and endpoints are set with <code>alden config</code>; see the docs.
        </p>
      </form>

      <div className="card">
        <h2>Your feedback</h2>
        {!feedback ? (
          <p className="muted">Loading…</p>
        ) : feedback.briefings === 0 ? (
          <p className="muted">
            None yet. Mark flags as <strong>Agree</strong> or <strong>Not needed</strong> in a briefing, and use{" "}
            <strong>You missed something</strong> when Alden missed what mattered.
          </p>
        ) : (
          <>
            <p>
              You agreed with{" "}
              <strong>{feedback.eyesAgreeRate === null ? "—" : `${Math.round(feedback.eyesAgreeRate * 100)}%`}</strong>{" "}
              of "needs your eyes" flags ({feedback.eyes.agree} of {feedback.eyes.agree + feedback.eyes.notNeeded})
              {feedback.modelFindings.agree + feedback.modelFindings.notNeeded > 0 &&
                `, and ${feedback.modelFindings.agree} of ${feedback.modelFindings.agree + feedback.modelFindings.notNeeded} of the model's other findings`}
              . {plural(feedback.missed, "miss", "misses")} reported across {plural(feedback.briefings, "briefing")}.
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Check</th>
                  <th scope="col">Agreed</th>
                  <th scope="col">Not needed</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(feedback.byCheck)
                  .sort(([, a], [, b]) => b.agree + b.notNeeded - (a.agree + a.notNeeded))
                  .map(([check, c]) => (
                    <tr key={check}>
                      <td className="mono">{check}</td>
                      <td>{c.agree}</td>
                      <td>{c.notNeeded}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </>
        )}
        <p className="faint small">
          Feedback stays on this machine. To share it, run <code>alden feedback --export feedback.json</code>, which
          leaves out repo names, paths and notes.
        </p>
      </div>

      <div className="card">
        <h2>Spend</h2>
        {spend ? (
          <>
            <p>
              <strong>{formatUsd(spend.spentToday)}</strong> of your {formatUsd(spend.dailyUsd)} daily cap today ·{" "}
              {formatUsd(Math.max(0, spend.dailyUsd - spend.spentToday))} left. Each review is capped at{" "}
              {formatUsd(spend.perReviewUsd)}.
            </p>
            {spend.byModel.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Model today</th>
                    <th scope="col">Calls</th>
                    <th scope="col">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {spend.byModel.map((row) => (
                    <tr key={row.model}>
                      <td className="mono">{row.model}</td>
                      <td>{row.calls}</td>
                      <td>{row.usd === null ? "not priced" : formatUsd(row.usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {spend.lastDays.length > 1 && (
              <p className="muted small">
                Recent days:{" "}
                {spend.lastDays
                  .slice(1)
                  .map((d) => `${d.day} ${formatUsd(d.usd)} (${plural(d.calls, "call")})`)
                  .join(" · ")}
              </p>
            )}
            <p className="faint small">Anthropic list prices. Local models aren't priced or capped.</p>
          </>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </div>
    </section>
  );
}
