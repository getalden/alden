import type { FollowUpLevel } from "@alden/schema";
import { useState } from "react";
import type { Api } from "../api";
import { Switch } from "./ReviewOptions";
import { Segmented } from "./Segmented";

/** The follow-up levels in order, as Settings and the bell on a PR name them. */
export const FOLLOW_UP_LEVELS: { level: FollowUpLevel; label: string; hint: string }[] = [
  { level: "off", label: "Off", hint: "No notifications about PRs you reviewed." },
  { level: "rereview", label: "Re-review only", hint: "When you're asked to review a PR again." },
  {
    level: "your-turn",
    label: "When it's your turn",
    hint: "A re-review, or when every comment you left is resolved or answered.",
  },
  {
    level: "every-reply",
    label: "Every reply",
    hint: "Each reply, resolve and re-review, and a push that changes the code under your comment.",
  },
];

/**
 * The desktop app's notifications, saved to your user config like `alden config set`: whether "Briefing ready" plays
 * the system's notification sound (`notifications.sound`, on unless you turn it off), and how much it tells you about
 * PRs you reviewed (`notifications.followUps`, "your turn" unless you choose). A PR's bell overrides the level.
 */
export function NotificationSettings(props: {
  api: Pick<Api, "setConfig">;
  sound: boolean;
  followUps?: FollowUpLevel | undefined;
  onSaved: () => void;
}) {
  const [sound, setSound] = useState(props.sound);
  const [level, setLevel] = useState<FollowUpLevel>(props.followUps ?? "your-turn");
  const [error, setError] = useState<string>();
  const change = (on: boolean) => {
    setSound(on);
    setError(undefined);
    props.api.setConfig("notifications.sound", on ? "true" : "false").then(props.onSaved, (e: Error) => {
      setSound(!on);
      setError(e.message);
    });
  };
  const choose = (next: FollowUpLevel) => {
    const before = level;
    setLevel(next);
    setError(undefined);
    props.api.setConfig("notifications.followUps", next).then(props.onSaved, (e: Error) => {
      setLevel(before);
      setError(e.message);
    });
  };
  return (
    <div className="card panel">
      <h2 className="label">Notifications</h2>
      <Switch on={sound} label="Play a sound when a briefing is ready" onChange={change} />
      <p className="faint small">
        The system's notification sound, with the notification Alden shows when a briefing it prepared is ready, and
        with follow-ups. Your Mac's Focus and notification settings still apply.
      </p>
      <span className="small">Follow-ups on PRs you reviewed</span>
      <Segmented label="Follow-ups on PRs you reviewed" style={{ alignSelf: "flex-start" }}>
        {FOLLOW_UP_LEVELS.map((l) => (
          <button key={l.level} type="button" aria-pressed={level === l.level} onClick={() => choose(l.level)}>
            {l.label}
          </button>
        ))}
      </Segmented>
      <p className="faint small">
        {FOLLOW_UP_LEVELS.find((l) => l.level === level)?.hint} One notification per PR at a time, never the same news
        twice. Any PR can have its own level: the bell beside it, or <code>alden watch</code>.
      </p>
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}
