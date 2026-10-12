import { useState } from "react";
import type { Api } from "../api";
import { Switch } from "./ReviewOptions";

/**
 * Whether Alden records how long your reviews take (`stats.reviewTime`, on unless you turn it off). Saved to your user
 * config, like `alden config set`.
 */
export function ReviewTimeSettings(props: { api: Pick<Api, "setConfig">; on: boolean; onSaved: () => void }) {
  const [on, setOn] = useState(props.on);
  const [error, setError] = useState<string>();
  const change = (next: boolean) => {
    setOn(next);
    setError(undefined);
    props.api.setConfig("stats.reviewTime", next ? "true" : "false").then(props.onSaved, (e: Error) => {
      setOn(!next);
      setError(e.message);
    });
  };
  return (
    <div className="card panel">
      <h2 className="label">Time to review</h2>
      <Switch on={on} label="Time my reviews" onChange={change} />
      <p className="faint small">
        For Stats → Time to review: when you first open a PR's briefing, how long the PR is in front of you in Alden
        (idle stretches over 2 minutes left out), how many flagged places you saw, how many comments you drafted, kept
        and sent, whether Alden's model helped, your verdict and when you sent it. Durations and counts only, never what
        the PR or your comments say, kept on this machine. With usage stats on, each sent review adds one event with
        rough times and counts. Off, Alden records none of it.
      </p>
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}
