import type { FollowUpLevel, PrWatch } from "@alden/schema";
import { useEffect, useState } from "react";
import type { Api } from "../api";

/** The bell's choices after "Default", as short as the header has room for. */
const CHOICES: { value: FollowUpLevel; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "rereview", label: "Re-review only" },
  { value: "your-turn", label: "Your turn" },
  { value: "every-reply", label: "Every reply" },
];
const labelOf = (level: FollowUpLevel) => CHOICES.find((c) => c.value === level)?.label ?? level;

function BellIcon({ off }: { off: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M4 11V7a4 4 0 0 1 8 0v4l1.5 1.5h-11L4 11Z" strokeLinejoin="round" />
      <path d="M6.5 14a1.5 1.5 0 0 0 3 0" strokeLinecap="round" />
      {off && <path d="M2.5 2.5l11 11" strokeLinecap="round" />}
    </svg>
  );
}

/**
 * The bell on a PR: how much the desktop app tells you about it after you review it. "Default" follows Settings →
 * Notifications (`notifications.followUps`, given as `global`); any other choice is this PR's own level until it's
 * merged or closed, as `alden watch` sets it.
 */
export function WatchBell(props: {
  api: Pick<Api, "watch" | "setWatch">;
  /** "owner/repo#12". */
  pr: string;
  global?: FollowUpLevel | undefined;
}) {
  const { api, pr } = props;
  const [watch, setWatch] = useState<PrWatch>();
  const [error, setError] = useState<string>();
  /** The global level as the server last said it, for when Settings didn't give it. */
  const [known, setKnown] = useState<FollowUpLevel>();
  const take = (w: PrWatch) => {
    setWatch(w);
    if (!w.override) setKnown(w.level);
  };
  useEffect(() => {
    let live = true;
    setWatch(undefined);
    setError(undefined);
    api.watch(pr).then(
      (w) => {
        if (!live) return;
        setWatch(w);
        if (!w.override) setKnown(w.level);
      },
      () => {}, // the bell stays disabled; nothing else on the page depends on it
    );
    return () => {
      live = false;
    };
  }, [api, pr]);

  const global = props.global ?? known ?? "your-turn";
  const choose = (value: string) => {
    const level = value === "" ? null : (value as FollowUpLevel);
    const before = watch;
    setError(undefined);
    setWatch({ pr, ...(level ? { override: level } : {}), level: level ?? global });
    api.setWatch(pr, level).then(take, (e: Error) => {
      setWatch(before);
      setError(e.message);
    });
  };

  return (
    <span className="watch-bell" title="Notifications about this PR after you review it">
      <BellIcon off={watch?.level === "off"} />
      <select
        className={`chip-select${watch?.override ? " on" : ""}`}
        aria-label="Notifications about this PR"
        value={watch?.override ?? ""}
        disabled={!watch}
        onChange={(e) => choose(e.target.value)}
      >
        <option value="">Default · {labelOf(global)}</option>
        {CHOICES.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
      {error && (
        <span className="error-text small" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
