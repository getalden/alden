import { useState } from "react";
import type { Api } from "../api";
import { Switch } from "./ReviewOptions";

/**
 * Whether a model briefing drafts comments for you (`drafts.auto`, on unless you turn it off). Saved to your user
 * config, like `alden config set drafts.auto false`.
 */
export function DraftSettings(props: { api: Pick<Api, "setConfig">; on: boolean; onSaved: () => void }) {
  const [on, setOn] = useState(props.on);
  const [error, setError] = useState<string>();
  const change = (next: boolean) => {
    setOn(next);
    setError(undefined);
    props.api.setConfig("drafts.auto", next ? "true" : "false").then(props.onSaved, (e: Error) => {
      setOn(!next);
      setError(e.message);
    });
  };
  return (
    <div className="card panel">
      <h2 className="label">Drafts</h2>
      <Switch on={on} label="Draft comments for me" onChange={change} />
      <p className="faint small">
        When a model briefs a PR, it also drafts a comment for up to five of its medium and high findings, in the same
        call (a little more output, on any model, at no other cost). They wait in Comments, marked "Drafted by Alden":
        keep, edit or drop each. Nothing is sent until you keep it and send your review, and a draft never approves.
        Keeping, editing and dropping them teaches Alden which findings are worth a comment.
      </p>
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}
