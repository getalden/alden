import type { Briefing, BriefingFreshness, BriefingTarget } from "@alden/schema";
import { useEffect, useRef, useState } from "react";
import { formatWait, plural } from "../format";

/** The window coming back to the front checks again, but not more often than this. */
const RECHECK_ON_FOCUS_MS = 60_000;

/** "briefed just now", "briefed 30m ago", "briefed 2h ago". */
export function briefedAgo(generatedAt: string, now: number = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(generatedAt)) / 60_000);
  return `briefed ${minutes >= 1 ? `${formatWait(minutes / 60)} ago` : "just now"}`;
}

/** What changed since a briefing, in a sentence (for the tooltip), or undefined while it still matches its PR. */
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

/** The same in a few characters for the age line: "main +4 commits", "PR +2 commits", "main moved". */
export function staleShort(freshness: BriefingFreshness | undefined): string | undefined {
  if (freshness?.state === "pr_changed") {
    return freshness.commits ? `PR +${plural(freshness.commits, "commit")}` : "PR changed";
  }
  if (freshness?.state === "base_moved") {
    return freshness.commits
      ? `${freshness.baseRef} +${plural(freshness.commits, "commit")}`
      : `${freshness.baseRef} moved`;
  }
  return undefined;
}

/**
 * The start of the age line: when the briefing was made and, when the PR or its base has moved on since, what
 * changed. Checks with GitHub when the briefing is shown and when the window regains focus (at most once a minute),
 * never on a timer. Local changes have nothing to check.
 */
export function BriefingAge(props: {
  briefing: Briefing;
  check?: ((target: BriefingTarget) => Promise<BriefingFreshness>) | undefined;
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

  const stale = staleShort(freshness);
  return (
    <span className="brief-age" role="status" title={staleText(freshness)}>
      {briefedAgo(briefing.generatedAt, now)}
      {stale && (
        <>
          {" · "}
          <span className="stale">{stale}</span>
        </>
      )}
    </span>
  );
}
