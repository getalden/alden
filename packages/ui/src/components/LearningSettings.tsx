import { useState } from "react";
import type { Api } from "../api";
import { Switch } from "./ReviewOptions";

/**
 * Whether Alden learns from the reviews you send (`learning.fromReviews`, on unless you turn it off). Saved to your
 * user config, like `alden config set`.
 */
export function LearningSettings(props: { api: Pick<Api, "setConfig">; on: boolean; onSaved: () => void }) {
  const [on, setOn] = useState(props.on);
  const [error, setError] = useState<string>();
  const change = (next: boolean) => {
    setOn(next);
    setError(undefined);
    props.api.setConfig("learning.fromReviews", next ? "true" : "false").then(props.onSaved, (e: Error) => {
      setOn(!next);
      setError(e.message);
    });
  };
  return (
    <div className="card panel">
      <h2 className="label">Learning</h2>
      <Switch on={on} label="Learn from my reviews" onChange={change} />
      <p className="faint small">
        When you send a review, Alden learns from what you commented on and what you let pass: a place you looked at and
        approved without a word counts as a quiet "not worth my time". To tell, Alden notes which places you saw (a
        guided step, or a marker in the Diff tab, in front of you for a second or two). That stays on this machine. Off,
        Alden notes nothing and learns only from Useful and Not useful.
      </p>
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}
