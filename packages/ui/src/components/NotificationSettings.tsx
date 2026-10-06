import { useState } from "react";
import type { Api } from "../api";
import { Switch } from "./ReviewOptions";

/**
 * The desktop app's notifications: whether "Briefing ready" plays the system's notification sound
 * (`notifications.sound`, on unless you turn it off). Saved to your user config, like `alden config set`.
 */
export function NotificationSettings(props: { api: Pick<Api, "setConfig">; sound: boolean; onSaved: () => void }) {
  const [sound, setSound] = useState(props.sound);
  const [error, setError] = useState<string>();
  const change = (on: boolean) => {
    setSound(on);
    setError(undefined);
    props.api.setConfig("notifications.sound", on ? "true" : "false").then(props.onSaved, (e: Error) => {
      setSound(!on);
      setError(e.message);
    });
  };
  return (
    <div className="card panel">
      <h2 className="label">Notifications</h2>
      <Switch on={sound} label="Play a sound when a briefing is ready" onChange={change} />
      <p className="faint small">
        The system's notification sound, with the notification Alden shows when a briefing it prepared is ready. Your
        Mac's Focus and notification settings still apply.
      </p>
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}
