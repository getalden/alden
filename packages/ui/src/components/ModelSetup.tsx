import type { KeyTestResult, ModelSetupState } from "@alden/schema";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { Api, SetupPage } from "../api";

const PAGES: Record<SetupPage, string> = {
  keys: "https://console.anthropic.com/settings/keys",
  cloud: "https://getalden.dev/cloud",
  ollama: "https://ollama.com/download",
};

/** What was set up, for the last screen. */
type Done = { kind: "key"; envFirst: string | null } | { kind: "local"; model: string };

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/**
 * A link to one of the setup pages. In the desktop app the window can't open tabs, so the server opens it in the
 * default browser instead.
 */
function PageLink(props: { api: Api; desktop: boolean; page: SetupPage; children: ReactNode }) {
  return (
    <a
      href={PAGES[props.page]}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        if (!props.desktop) return;
        event.preventDefault();
        void props.api.openSetupPage(props.page).catch(() => {});
      }}
    >
      {props.children}
    </a>
  );
}

/**
 * "Set up a model", where the briefing options said "No model set up": the same three choices as `alden setup`, in the
 * same order. An Anthropic key (checked with one tiny request, then kept in the keychain), a local model through
 * Ollama, or checks only; then the Alden Cloud line. Reviews read the config and the key afresh, so nothing restarts.
 */
export function ModelSetupDialog(props: { api: Api; desktop: boolean; onClose: () => void; onReady: () => void }) {
  const { api, desktop, onClose } = props;
  const [state, setState] = useState<ModelSetupState>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<"key" | "local">("key");
  const [done, setDone] = useState<Done>();
  const dialog = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    setError(undefined);
    api.modelSetup().then(setState, (e: Error) => setError(e.message));
  }, [api]);
  useEffect(load, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    dialog.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const link = (page: SetupPage, text: ReactNode) => (
    <PageLink api={api} desktop={desktop} page={page}>
      {text}
    </PageLink>
  );

  return (
    <div className="modal-backdrop">
      <div
        ref={dialog}
        className="modal card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-setup-title"
        tabIndex={-1}
      >
        <header className="modal-head">
          <h2 id="model-setup-title">Set up a model</h2>
          <button type="button" className="btn quiet icon" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        {done ? (
          <DoneStep done={done} onReady={props.onReady} />
        ) : (
          <>
            <p className="muted">
              Alden's checks run without one. With a model, each briefing also says what the change does, whether it
              matches its title, and adds findings on the lines that need you.
            </p>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            <SetupChoice
              title="Paste an Anthropic API key"
              tag="Recommended"
              summary="Claude, with your own key: the most thorough briefings."
              expanded={open === "key"}
              onExpand={() => setOpen("key")}
            >
              <KeyStep
                api={api}
                state={state}
                link={link}
                onDone={(result) =>
                  setDone({ kind: "key", envFirst: result.key?.source === "env" ? result.key.where : null })
                }
              />
            </SetupChoice>
            <SetupChoice
              title="Use a local model"
              summary="Free and private, through Ollama on this machine."
              expanded={open === "local"}
              onExpand={() => setOpen("local")}
            >
              <LocalStep
                api={api}
                state={state}
                link={link}
                onLook={load}
                onDone={(model) => setDone({ kind: "local", model })}
              />
            </SetupChoice>
            <div className="setup-choice">
              <div className="setup-choice-head static">
                <span className="setup-choice-title">Checks only</span>
                <span className="muted small">No model: Alden's checks and callers, at no cost.</span>
              </div>
              <div className="form-actions">
                <button type="button" className="btn sm" onClick={onClose}>
                  Use checks only
                </button>
              </div>
            </div>
            <p className="faint small">
              If you'd rather Alden handled everything, sign up for {link("cloud", "Alden Cloud (beta)")}.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function SetupChoice(props: {
  title: string;
  tag?: string;
  summary: string;
  expanded: boolean;
  onExpand: () => void;
  children: ReactNode;
}) {
  return (
    <section className={`setup-choice${props.expanded ? " open" : ""}`}>
      <button type="button" className="setup-choice-head" aria-expanded={props.expanded} onClick={props.onExpand}>
        <span className="setup-choice-title">
          {props.title}
          {props.tag && <span className="pill">{props.tag}</span>}
        </span>
        <span className="muted small">{props.summary}</span>
      </button>
      {props.expanded && <div className="setup-choice-body">{props.children}</div>}
    </section>
  );
}

function KeyStep(props: {
  api: Api;
  state: ModelSetupState | undefined;
  link: (page: SetupPage, text: ReactNode) => ReactNode;
  onDone: (result: Extract<KeyTestResult, { ok: true }>) => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Extract<KeyTestResult, { ok: false }>>();
  const existing = props.state?.key;

  const submit = (untested: boolean) => {
    setBusy(true);
    setFailure(undefined);
    props.api
      .testModelKey(key.trim(), untested)
      .then(
        (result) => (result.ok ? props.onDone(result) : setFailure(result)),
        (e: Error) => setFailure({ ok: false, reason: "other", message: e.message }),
      )
      .finally(() => setBusy(false));
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (key.trim()) submit(false);
  };
  const unreachable = failure?.reason === "network" || failure?.reason === "unavailable";

  return (
    <form className="setup-step" onSubmit={onSubmit}>
      <p className="small">
        Create a key at {props.link("keys", "console.anthropic.com")}, then paste it here.
        {existing && ` Alden already finds one, from ${existing.where}; a key here is stored for where that isn't set.`}
      </p>
      <label className="field">
        Anthropic API key
        <input
          className="input mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-ant-api03-…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <span className="help">
          Alden checks it with one tiny request (a fraction of a cent), then keeps it in your keychain. It's never shown
          again.
        </span>
      </label>
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy || !key.trim()}>
          {busy ? "Checking…" : "Check and store"}
        </button>
        {unreachable && (
          <button type="button" className="btn" disabled={busy} onClick={() => submit(true)}>
            Store without checking
          </button>
        )}
      </div>
      {failure && (
        <p className="error-text small" role="alert">
          {failure.message}
        </p>
      )}
    </form>
  );
}

/** A choice in the local model list: the recommended one (maybe to download), then everything Ollama has. */
interface LocalOption {
  model: string;
  pull: boolean;
  label: string;
}

export function localOptions(state: ModelSetupState): LocalOption[] {
  const rec = state.recommendation;
  const options: LocalOption[] = rec.installed
    ? []
    : [
        {
          model: rec.model,
          pull: true,
          label: `${rec.model} · recommended · downloads about ${rec.download}`,
        },
      ];
  for (const m of state.ollama.models) {
    const size = m.sizeBytes ? formatBytes(m.sizeBytes) : "";
    const note = m.name === rec.model ? "recommended" : size;
    options.push({ model: m.name, pull: false, label: note ? `${m.name} · ${note}` : m.name });
  }
  return options;
}

function LocalStep(props: {
  api: Api;
  state: ModelSetupState | undefined;
  link: (page: SetupPage, text: ReactNode) => ReactNode;
  onLook: () => void;
  onDone: (model: string) => void;
}) {
  const { state } = props;
  const [choice, setChoice] = useState<string>();
  const [progress, setProgress] = useState<{ status: string; completed: number | null; total: number | null }>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const stop = useRef<AbortController>(undefined);
  useEffect(() => () => stop.current?.abort(), []);

  if (!state) return <p className="muted small">Looking for Ollama…</p>;
  const caveat = (
    <p className="small muted">
      The model runs on this machine and nothing leaves it. Local models flag less than Claude: expect fewer findings,
      and more missed.
    </p>
  );
  if (!state.ollama.reachable) {
    return (
      <div className="setup-step">
        {caveat}
        <p className="small">
          Ollama isn't running at <code>{state.ollama.url}</code>. Install it from {props.link("ollama", "ollama.com")}{" "}
          and start it, then look again.
        </p>
        <div className="form-actions">
          <button type="button" className="btn sm" onClick={props.onLook}>
            Look again
          </button>
        </div>
      </div>
    );
  }

  const options = localOptions(state);
  const picked = options.find((o) => o.model === choice) ?? options[0];
  const start = () => {
    if (!picked) return;
    const controller = new AbortController();
    stop.current = controller;
    setRunning(true);
    setError(undefined);
    setProgress(undefined);
    props.api
      .setUpLocalModel(
        picked.model,
        (event) => {
          if (event.type === "progress") setProgress(event);
        },
        controller.signal,
      )
      .then(props.onDone, (e: Error) => setError(controller.signal.aborted ? "Stopped the download." : e.message))
      .finally(() => setRunning(false));
  };
  const share = progress?.total && progress.completed !== null ? progress.completed / progress.total : undefined;

  return (
    <div className="setup-step">
      {caveat}
      <p className="small">
        Ollama{state.ollama.version ? ` ${state.ollama.version}` : ""} is running. This machine has {state.memoryGb} GB
        of memory.
      </p>
      {options.length > 0 ? (
        <label className="field">
          Model
          <select
            className="input"
            value={picked?.model}
            disabled={running}
            onChange={(e) => setChoice(e.target.value)}
          >
            {options.map((o) => (
              <option key={o.model} value={o.model}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="help">
            {picked?.model === state.recommendation.model
              ? `Recommended for this machine: ${state.recommendation.why}.`
              : `For this machine Alden suggests ${state.recommendation.model} (${state.recommendation.why}).`}
          </span>
        </label>
      ) : null}
      {running && (
        <div className="setup-progress" role="status" aria-live="polite">
          <progress max={1} value={share} aria-label="Download progress" />
          <span className="faint small mono">
            {progress?.status ?? "Starting…"}
            {share !== undefined && progress?.total
              ? ` · ${Math.floor(share * 100)}% of ${formatBytes(progress.total)}`
              : ""}
          </span>
        </div>
      )}
      <div className="form-actions">
        <button type="button" className="btn primary" disabled={running || !picked} onClick={start}>
          {picked?.pull ? "Download and use" : "Use this model"}
        </button>
        {running && picked?.pull && (
          <button type="button" className="btn" onClick={() => stop.current?.abort()}>
            Stop
          </button>
        )}
      </div>
      {error && (
        <p className="error-text small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function DoneStep({ done, onReady }: { done: Done; onReady: () => void }) {
  return (
    <div className="setup-step" role="status">
      <p>
        <span className="ok-text">✓</span>{" "}
        {done.kind === "key"
          ? "Your key works, and it's in your keychain. Briefings now ask Claude."
          : `Briefings now use ${done.model} on Ollama.`}
      </p>
      <p className="muted small">
        No restart needed: the next briefing uses it, here and in the terminal.
        {done.kind === "key" && done.envFirst
          ? ` ${done.envFirst} is set where Alden runs and comes first; the stored key is used where it isn't, such as the desktop app.`
          : ""}
      </p>
      <div className="form-actions">
        <button type="button" className="btn primary" onClick={onReady}>
          Done
        </button>
      </div>
    </div>
  );
}
