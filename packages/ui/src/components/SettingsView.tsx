import type { FeedbackSummary } from "@alden/schema";
import { type FormEvent, useEffect, useState } from "react";
import type { Api, Session, SpendReport } from "../api";
import { formatUsd, plural } from "../format";
import { applyTheme, readTheme, type Theme } from "../theme";
import { NotificationSettings } from "./NotificationSettings";
import { RankingSettings } from "./RankingSettings";
import { Switch } from "./ReviewOptions";
import { Segmented } from "./Segmented";
import { TelemetrySettings } from "./TelemetryCard";

/** Saves `data` as a file the browser downloads, without a server round trip. */
function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** Defaults for every review (saved to your user config, like `alden config set`), your feedback, and today's spend. */
export function SettingsView({ api, session, onSaved }: { api: Api; session: Session; onSaved: () => void }) {
  const [spend, setSpend] = useState<SpendReport>();
  const [feedback, setFeedback] = useState<FeedbackSummary>();
  const [model, setModel] = useState(session.model.name);
  const [effort, setEffort] = useState(session.model.effort ?? "");
  const [perReview, setPerReview] = useState(String(session.budget.perReviewUsd));
  const [daily, setDaily] = useState(String(session.budget.dailyUsd));
  const [eyes, setEyes] = useState(String(session.eyes ?? 3));
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string }>();
  const [saving, setSaving] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [exportStatus, setExportStatus] = useState<string>();

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
    if (Number(eyes) !== (session.eyes ?? 3)) changes.push(["review.eyes", eyes]);
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

  async function exportFeedback() {
    setExportStatus(undefined);
    try {
      const events = await api.exportFeedback();
      download(`alden-feedback-${new Date().toISOString().slice(0, 10)}.json`, events);
      setExportStatus(`Saved ${plural(events.length, "event")}.`);
    } catch (error) {
      setExportStatus((error as Error).message);
    }
  }

  const verdicts = feedback ? feedback.agree + feedback.notNeeded : 0;
  const pct = (n: number) => (verdicts === 0 ? 0 : Math.round((n / verdicts) * 100));
  const spent = spend?.spentToday ?? session.budget.spentToday;
  const cap = spend?.dailyUsd ?? session.budget.dailyUsd;

  return (
    <section className="page-inner" aria-labelledby="settings-title">
      <div className="settings-grid">
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <h1 className="page-title" id="settings-title">
            Settings
          </h1>

          <form className="card panel" onSubmit={save}>
            <h2 className="label">Model</h2>
            <div className="two">
              <label className="field">
                Default model
                <select className="input mono" value={model} onChange={(e) => setModel(e.target.value)}>
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {session.aliases[m] ?? m}
                    </option>
                  ))}
                </select>
                <span className="help">
                  {session.model.available ? `via ${session.model.provider}` : session.model.reason}
                </span>
              </label>
              <div className="field">
                Default effort
                <Segmented label="Default effort" style={{ height: 34 }}>
                  <button type="button" aria-pressed={effort === ""} onClick={() => setEffort("")}>
                    Auto
                  </button>
                  {session.efforts.map((e) => (
                    <button key={e} type="button" aria-pressed={effort === e} onClick={() => setEffort(e)}>
                      {e.charAt(0).toUpperCase() + e.slice(1)}
                    </button>
                  ))}
                </Segmented>
              </div>
            </div>
            <h2 className="label sep">Spend caps</h2>
            <div className="two">
              <label className="field">
                Per briefing
                <span className="money">
                  <span className="faint mono">$</span>
                  <input
                    className="input"
                    inputMode="decimal"
                    value={perReview}
                    onChange={(e) => setPerReview(e.target.value)}
                  />
                </span>
              </label>
              <label className="field">
                Per day
                <span className="money">
                  <span className="faint mono">$</span>
                  <input
                    className="input"
                    inputMode="decimal"
                    value={daily}
                    onChange={(e) => setDaily(e.target.value)}
                  />
                </span>
              </label>
            </div>
            <h2 className="label sep">Briefings</h2>
            <label className="field" style={{ maxWidth: 260 }}>
              Places in "Needs your eyes"
              <input
                className="input"
                type="number"
                min={1}
                max={10}
                value={eyes}
                onChange={(e) => setEyes(e.target.value)}
              />
              <span className="help">The few places to look first, 1 to 10. Default 3.</span>
            </label>
            <p className="muted small">
              When a briefing would pass its cap, Alden doesn't ask the model and shows the checks. Changes go to your
              user config, like <code>alden config set</code>; a repo's <code>.alden.toml</code> still overrides them
              there.
            </p>
            <div className="form-actions">
              <button type="submit" className="btn primary" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
              {status && <span className={status.tone === "error" ? "error-text" : "muted"}>{status.text}</span>}
            </div>
          </form>

          {session.model.provider === "anthropic" && (
            <ModelKeySettings api={api} initial={session.model.key ?? null} onSaved={onSaved} />
          )}

          <div className="card panel">
            <div className="section-head">
              <h2 className="label">Your feedback</h2>
              {feedback?.since && <span className="faint mono small">since {feedback.since.slice(0, 10)}</span>}
            </div>
            {!feedback ? (
              <p className="muted">Loading…</p>
            ) : feedback.briefings === 0 ? (
              <p className="muted">
                None yet. Mark places <strong>Useful</strong> or <strong>Not useful</strong> in a briefing, and use{" "}
                <strong>You missed something</strong> when Alden missed what mattered.
              </p>
            ) : (
              <>
                <div className="stack-bar" aria-hidden="true">
                  <span className="a" style={{ width: `${pct(feedback.agree)}%` }} />
                  <span className="n" style={{ width: `${pct(feedback.notNeeded)}%` }} />
                </div>
                <div className="two" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
                  <span>
                    <b className="big-num">{pct(feedback.agree)}%</b>
                    <br />
                    <span className="muted small">You found useful</span>
                  </span>
                  <span>
                    <b className="big-num">{pct(feedback.notNeeded)}%</b>
                    <br />
                    <span className="muted small">Not useful</span>
                  </span>
                  <span>
                    <b className="big-num">{feedback.missed}</b>
                    <br />
                    <span className="muted small">Things Alden missed</span>
                  </span>
                </div>
                <p className="muted small">
                  On "needs your eyes": {feedback.eyes.agree} of {feedback.eyes.agree + feedback.eyes.notNeeded} useful
                  {feedback.eyesAgreeRate !== null && ` (${Math.round(feedback.eyesAgreeRate * 100)}%)`}. Across{" "}
                  {plural(feedback.briefings, "briefing")}, {plural(feedback.dismissed, "place")} dismissed.
                </p>
              </>
            )}
            <div className="form-actions" style={{ paddingTop: 12, borderTop: "1px solid var(--line)" }}>
              <button type="button" className="btn sm" onClick={exportFeedback}>
                Export redacted feedback
              </button>
              <span className="faint small">
                {exportStatus ?? "Repo names become codes; titles, paths and notes are removed."}
              </span>
            </div>
          </div>

          <QueueScopeSettings api={api} initial={session.queueScope} onSaved={onSaved} />

          <RankingSettings api={api} desktop={session.desktop === true} onSaved={onSaved} />

          {session.desktop && session.cli && session.cli.state !== "unavailable" && (
            <CliSettings api={api} initial={session.cli} />
          )}

          {session.desktop && session.background && (
            <BackgroundSettings api={api} initial={session.background} onSaved={onSaved} />
          )}

          {session.desktop && (
            <NotificationSettings api={api} sound={session.notifications?.sound ?? true} onSaved={onSaved} />
          )}

          <TelemetrySettings api={api} />

          <div className="card panel">
            <h2 className="label">Appearance</h2>
            <Segmented label="Theme" style={{ alignSelf: "flex-start" }}>
              {(["system", "light", "dark"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={theme === t}
                  onClick={() => {
                    setTheme(t);
                    applyTheme(t);
                  }}
                >
                  {t === "system" ? "Match system" : t === "light" ? "Light" : "Dark"}
                </button>
              ))}
            </Segmented>
          </div>
        </div>

        <aside className="card panel" style={{ marginTop: 54 }} aria-labelledby="today">
          <h2 className="label" id="today">
            Today
          </h2>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span className="today-num">{formatUsd(spent)}</span>
            <span className="faint mono small">of {formatUsd(cap)}</span>
          </div>
          <div className={`meter${spent >= cap ? " over" : ""}`} aria-hidden="true">
            <span style={{ width: `${Math.min(100, cap > 0 ? (spent / cap) * 100 : 0)}%` }} />
          </div>
          {spend?.todayByPurpose && spend.todayByPurpose.length > 0 ? (
            <ul className="spend-list">
              {spend.todayByPurpose.map((p) => (
                <li key={p.purpose}>
                  <span title={p.purpose}>{p.purpose}</span>
                  <span>{formatUsd(p.usd)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No model calls today.</p>
          )}
          {spend && spend.lastDays.length > 1 && (
            <p className="faint small">
              {spend.lastDays
                .slice(1, 4)
                .map((d) => `${d.day.slice(5)} ${formatUsd(d.usd)}`)
                .join(" · ")}
            </p>
          )}
          <p className="faint small">Anthropic list prices. Local models aren't priced or capped.</p>
        </aside>
      </div>
    </section>
  );
}

/**
 * The Anthropic API key, stored in the keychain as `alden auth model` does, so the desktop app (which never sees your
 * shell's ANTHROPIC_API_KEY) can ask the model. Write-only: the page never gets the key back, only where it comes from.
 */
function ModelKeySettings(props: { api: Api; initial: Session["model"]["key"] | null; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [current, setCurrent] = useState(props.initial);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string }>();
  const [busy, setBusy] = useState(false);
  const change = (value: string | null) => {
    setBusy(true);
    setStatus(undefined);
    props.api
      .setModelKey(value)
      .then(
        (result) => {
          setCurrent(result.key ?? null);
          setKey("");
          setStatus({ tone: "ok", text: value === null ? "Removed the stored key." : "Stored in your keychain." });
          props.onSaved();
        },
        (e: Error) => setStatus({ tone: "error", text: e.message }),
      )
      .finally(() => setBusy(false));
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (key.trim()) change(key);
  };
  return (
    <form className="card panel" onSubmit={save}>
      <h2 className="label">Anthropic API key</h2>
      <p className="muted small">
        {current ? `Alden uses ${current.where}.` : "None yet, so briefings run the checks only."} A key here goes to
        your keychain, like <code>alden auth model</code>, and works in the desktop app, the terminal and{" "}
        <code>alden mcp</code>. ANTHROPIC_API_KEY, where it's set, comes first.
      </p>
      <label className="field">
        {current?.source === "alden" ? "Replace the key" : "Key"}
        <input
          className="input mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-ant-api03-…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <span className="help">From console.anthropic.com. It's never shown again, here or anywhere in Alden.</span>
      </label>
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy || !key.trim()}>
          Store key
        </button>
        {current?.source === "alden" && (
          <button type="button" className="btn" disabled={busy} onClick={() => change(null)}>
            Remove stored key
          </button>
        )}
        {status && (
          <span className={status.tone === "error" ? "error-text" : "muted"} role="status">
            {status.text}
          </span>
        )}
      </div>
    </form>
  );
}

/** The desktop app's background briefings: on or off, and whether they may ask the model (and so spend). */
function BackgroundSettings(props: { api: Api; initial: { enabled: boolean; model: boolean }; onSaved: () => void }) {
  const [state, setState] = useState(props.initial);
  const [error, setError] = useState<string>();
  const change = (key: "enabled" | "model", on: boolean) => {
    const before = state;
    setState({ ...state, [key]: on });
    setError(undefined);
    props.api.setConfig(`background.${key}`, on ? "true" : "false").then(props.onSaved, (e: Error) => {
      setState(before);
      setError(e.message);
    });
  };
  return (
    <div className="card panel">
      <h2 className="label">While you're away</h2>
      <p className="muted small">
        When your Mac has been idle for a few minutes, Alden briefs the top PRs waiting on you, one at a time, and tells
        you when one is ready. It briefs a PR again only after it changes.
      </p>
      <Switch on={state.enabled} label="Prepare briefings in the background" onChange={(on) => change("enabled", on)} />
      <Switch
        on={state.model}
        disabled={!state.enabled}
        label="Ask the model too"
        title="Spends within your caps, like any briefing"
        onChange={(on) => change("model", on)}
      />
      <p className="faint small">
        Without the model they're checks and callers only, which costs nothing. With it, each counts against your
        per-briefing and daily caps. This setting lives in your user config only, so a repo can't turn it on.
      </p>
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}

/** The desktop app's `alden` command: the terminal, `alden mcp` and the Claude Code plugin all need it on the PATH. */
function CliSettings({ api, initial }: { api: Api; initial: NonNullable<Session["cli"]> }) {
  const [status, setStatus] = useState(initial);
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState(false);
  const install = () => {
    setBusy(true);
    setNote(undefined);
    api
      .installCli()
      .then(
        (result) => {
          if (result.state === "installed") setNote("Installed. Open a new terminal window and run alden --version.");
          if (result.state === "exists") setNote(`There's already an alden command at ${result.path}.`);
          if (result.state === "failed") setNote(`Couldn't install it: ${result.message}`);
          return api.cliStatus().then(setStatus);
        },
        (e: Error) => setNote(e.message),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div className="card panel">
      <h2 className="label">Command line tool</h2>
      {status.state === "installed" ? (
        <p className="muted small">
          <code>alden</code> is installed at <code>{status.path}</code>
          {status.ours ? ", from this app, and updates with it." : " (from Homebrew or npm)."} The terminal, the desktop
          app, <code>alden mcp</code> and the Claude Code plugin share your sign-in, settings and memory.
        </p>
      ) : (
        <>
          <p className="muted small">
            The app runs its own copy of <code>alden</code>. Install it as a command to use Alden in a terminal, and for{" "}
            <code>alden mcp</code> and the Claude Code plugin. macOS asks for your password, since it goes in{" "}
            <code>/usr/local/bin</code>.
          </p>
          <div className="form-actions">
            <button type="button" className="btn primary" onClick={install} disabled={busy}>
              {busy ? "Waiting for macOS…" : "Install the alden command"}
            </button>
          </div>
        </>
      )}
      {note && <p className="small">{note}</p>}
    </div>
  );
}

/** What this machine's queue covers: a work laptop can show only work orgs, a personal one only your own repos. */
function QueueScopeSettings(props: { api: Api; initial: Session["queueScope"]; onSaved: () => void }) {
  const join = (list: string[] | undefined) => (list ?? []).join(", ");
  const [orgs, setOrgs] = useState(join(props.initial?.orgs));
  const [repos, setRepos] = useState(join(props.initial?.repos));
  const [ignore, setIgnore] = useState(join(props.initial?.ignore));
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string }>();
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setStatus(undefined);
    try {
      for (const [key, value] of [
        ["queue.orgs", orgs],
        ["queue.repos", repos],
        ["queue.ignore", ignore],
      ] as const) {
        await props.api.setConfig(key, value.trim() ? value : null);
      }
      setStatus({ tone: "ok", text: "Saved for this machine. The queue updates on its next refresh." });
      props.onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: (error as Error).message });
    }
  };
  return (
    <form className="card panel" onSubmit={save}>
      <h2 className="label">Your queue on this machine</h2>
      <p className="muted small">
        Leave these empty to see every PR waiting on you. Set them per machine: only your company's organisation on a
        work laptop, only your own repos on a personal one. Comma-separated.
      </p>
      <label className="field">
        Only these organisations
        <input className="input mono" value={orgs} placeholder="acme" onChange={(e) => setOrgs(e.target.value)} />
      </label>
      <label className="field">
        Only these repos
        <input
          className="input mono"
          value={repos}
          placeholder="owner/name, owner/other"
          onChange={(e) => setRepos(e.target.value)}
        />
      </label>
      <label className="field">
        Leave out
        <input
          className="input mono"
          value={ignore}
          placeholder="an-org, owner/noisy-repo"
          onChange={(e) => setIgnore(e.target.value)}
        />
        <span className="help">Organisations or repos to hide, even when they're covered above.</span>
      </label>
      <div className="form-actions">
        <button type="submit" className="btn primary">
          Save
        </button>
        {status && <span className={status.tone === "error" ? "error-text" : "muted"}>{status.text}</span>}
      </div>
    </form>
  );
}
