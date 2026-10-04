import { useEffect, useState } from "react";
import type { Api, Telemetry } from "../api";
import { Mark } from "./Mark";
import { Segmented } from "./Segmented";

export const TELEMETRY_WHAT =
  "Which views and commands you use, how reviews go (counts, timings, the model used) and which way your feedback points. Never code, diffs, titles, paths, repo or user names.";

/** The question, asked once: shown at the top of the queue until you answer, in the UI or the terminal. */
export function TelemetryCard({ api }: { api: Api }) {
  const [state, setState] = useState<Telemetry>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api.telemetry().then(setState, () => setState(undefined));
  }, [api]);
  if (state?.consent !== "unset" || state.blocked) return null;

  const answer = (on: boolean) =>
    api.setTelemetry(on).then(setState, (e: Error) => setError(`Couldn't save that: ${e.message}`));

  return (
    <section className="telemetry-card" aria-labelledby="telemetry-title">
      <Mark size={18} />
      <div className="text">
        <h2 id="telemetry-title" className="h3">
          Help shape Alden?
        </h2>
        <p className="muted small">
          With your OK, Alden sends anonymous usage stats to its developers. {TELEMETRY_WHAT} Change it any time in
          Settings.
        </p>
        {error && <p className="error-text small">{error}</p>}
        <div className="form-actions" style={{ marginTop: 8 }}>
          <button type="button" className="btn sm primary" onClick={() => answer(true)}>
            Send anonymous stats
          </button>
          <button type="button" className="btn sm quiet" onClick={() => answer(false)}>
            No thanks
          </button>
        </div>
      </div>
    </section>
  );
}

/** Settings' panel: the same choice, and what's forcing it off if anything is. */
export function TelemetrySettings({ api }: { api: Api }) {
  const [state, setState] = useState<Telemetry>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api.telemetry().then(setState, () => setState(undefined));
  }, [api]);
  const on = state?.consent === "on";
  return (
    <div className="card panel">
      <h2 className="label">Usage stats</h2>
      <p className="muted small">
        Anonymous, and only if you say yes. {TELEMETRY_WHAT} Sent to PostHog in the EU. `alden telemetry show` prints
        exactly what's waiting to be sent.
      </p>
      {state?.blocked ? (
        <p className="small">Off: {state.blocked}.</p>
      ) : (
        <Segmented label="Usage stats" style={{ alignSelf: "flex-start" }}>
          <button
            type="button"
            aria-pressed={on}
            disabled={!state}
            onClick={() => api.setTelemetry(true).then(setState, (e: Error) => setError(e.message))}
          >
            Send anonymous stats
          </button>
          <button
            type="button"
            aria-pressed={state !== undefined && !on}
            disabled={!state}
            onClick={() => api.setTelemetry(false).then(setState, (e: Error) => setError(e.message))}
          >
            Don't send
          </button>
        </Segmented>
      )}
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}
