import type { Briefing, BriefingFreshness, BriefingTarget } from "@alden/schema";
import { useEffect, useRef, useState } from "react";
import { fetchedAgo, plural } from "../format";

/** The window coming back to the front checks again, but not more often than this. */
const RECHECK_ON_FOCUS_MS = 60_000;

/** "Briefed just now", "Briefed 30 min ago", "Briefed 2h ago". */
export function briefedAgo(generatedAt: string, now: number = Date.now()): string {
  return `Briefed ${fetchedAgo(generatedAt, now) ?? "just now"}`;
}

/** What changed since a briefing, in a few words, or undefined while it still matches its PR. */
export function staleText(freshness: BriefingFreshness | undefined): string | undefined {
  if (freshness?.state === "pr_changed") {
    return freshness.commits ? `the PR has ${plural(freshness.commits, "new commit")}` : "the PR has changed since";
  }
  if (freshness?.state === "base_moved") {
    return freshness.commits
      ? `${freshness.baseRef} has ${plural(freshness.commits, "new commit")} since`
      : `${freshness.baseRef} has moved since`;
  }
  return undefined;
}

/**
 * When a PR briefing was made and, when the PR or its base has moved on since, what changed and a way to brief again.
 * Checks with GitHub when the briefing is shown and when the window regains focus (at most once a minute), never on a
 * timer.
 */
export function BriefingAge(props: {
  briefing: Briefing;
  check?: ((target: BriefingTarget) => Promise<BriefingFreshness>) | undefined;
  onRebrief: () => void;
}) {
  const { briefing, check } = props;
  const [freshness, setFreshness] = useState<BriefingFreshness>();
  const [now, setNow] = useState(Date.now());
  const checkedAt = useRef(0);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setFreshness(undefined);
    if (!check || briefing.target.kind !== "pr") return;
    let live = true;
    const target = briefing.target;
    const ask = () => {
      checkedAt.current = Date.now();
      check(target).then(
        (found) => {
          if (live) setFreshness(found);
        },
        // Offline or signed out: say nothing rather than guess.
        () => {},
      );
    };
    const onFocus = () => {
      setNow(Date.now());
      if (document.visibilityState !== "hidden" && Date.now() - checkedAt.current >= RECHECK_ON_FOCUS_MS) ask();
    };
    ask();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      live = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [check, briefing.target]);

  const stale = staleText(freshness);
  return (
    <div className="brief-age" role="status">
      <span>
        {briefedAgo(briefing.generatedAt, now)}
        {stale ? " · " : ""}
      </span>
      {stale && (
        <>
          <span className="stale">{stale} ·</span>
          <button type="button" className="btn xs" onClick={props.onRebrief}>
            Re-brief
          </button>
        </>
      )}
    </div>
  );
}
