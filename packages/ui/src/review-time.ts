import { createContext, useContext, useEffect } from "react";

/*
 * Time to review: how long the PR pane is in front of you, sent to the local API (which keeps it on this machine, and
 * only while `stats.reviewTime` is on). Active means the window is visible and focused; a stretch with no input
 * (a key, a click, the pointer moving, a scroll) longer than 2 minutes doesn't count at all, so walking away, or leaving
 * the window open in front of you while doing something else, adds nothing.
 */

/** A stretch with no input longer than this isn't active time: the whole stretch, not just what's over. */
export const IDLE_MS = 2 * 60_000;
/** How often what's been counted is sent. */
export const REPORT_EVERY_MS = 15_000;
/** The most one report carries (the server takes 5 minutes); anything more is split. */
const MAX_REPORT_MS = 5 * 60_000;

/**
 * Active time, from moments of activity: the time between two moments counts when it's 2 minutes or less. `pause`
 * (the pane hidden, the window blurred, closed) counts up to then and stops until the next activity.
 */
export class ActiveClock {
  private last: number | undefined;
  private pending = 0;

  constructor(private readonly idleMs = IDLE_MS) {}

  /** Activity at `now`, with the pane in front of you: input, the window gaining focus, the tab becoming visible. */
  activity(now: number): void {
    if (this.last !== undefined) {
      const gap = now - this.last;
      if (gap > 0 && gap <= this.idleMs) this.pending += gap;
    }
    this.last = now;
  }

  /** The pane went out of view at `now`. */
  pause(now: number): void {
    this.activity(now);
    this.last = undefined;
  }

  /** What's been counted since the last take, in whole milliseconds. */
  take(): number {
    const ms = Math.round(this.pending);
    this.pending = 0;
    return ms;
  }
}

/** Reports active time on a PR ("owner/repo#12") to the local API. */
export type ReportActive = (pr: string, activeMs: number) => Promise<unknown>;

/** Set around the app when there's a local API and `stats.reviewTime` is on; absent, nothing is measured. */
export const ReviewTimeContext = createContext<ReportActive | undefined>(undefined);

/** The PR panes measuring now, by PR, so sending a review can report their last seconds first. */
const flushers = new Map<string, Set<() => Promise<void>>>();
const keyOf = (pr: string) => pr.trim().toLowerCase();

/** Reports what's been measured on a PR so far, before its review is sent (which ends the review's session). */
export async function flushActiveTime(pr: string): Promise<void> {
  await Promise.all([...(flushers.get(keyOf(pr)) ?? [])].map((flush) => flush().catch(() => {})));
}

/** Whether the page is in front of you: the tab visible and the window focused. */
function inFront(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

const ACTIVITY = ["pointerdown", "pointermove", "keydown", "wheel", "scroll", "touchstart"] as const;

/**
 * Measures active time on a PR's pane while it's mounted, and reports it every 15 seconds, when the window loses focus
 * or the page goes away, and when the pane closes. `pr` undefined (your local changes, or no briefing yet) measures
 * nothing. Errors are ignored: a report that didn't land only means a review looks a little quicker.
 */
export function useActiveTime(pr: string | undefined): void {
  const report = useContext(ReviewTimeContext);
  useEffect(() => {
    if (!pr || !report) return;
    const clock = new ActiveClock();
    const flush = async () => {
      let ms = clock.take();
      while (ms > 0) {
        const part = Math.min(ms, MAX_REPORT_MS);
        ms -= part;
        try {
          await report(pr, part);
        } catch {
          // ignored, as above
        }
      }
    };
    const onActivity = () => {
      if (inFront()) clock.activity(Date.now());
      else clock.pause(Date.now());
    };
    const onAway = () => {
      clock.pause(Date.now());
      void flush();
    };
    const onVisibility = () => (document.visibilityState === "visible" ? onActivity() : onAway());
    // Sending the review reports up to now first; the clock goes on from there (the session has ended by then).
    const beforeSend = async () => {
      if (inFront()) clock.activity(Date.now());
      await flush();
    };
    const key = keyOf(pr);
    const set = flushers.get(key) ?? new Set();
    set.add(beforeSend);
    flushers.set(key, set);

    if (inFront()) clock.activity(Date.now());
    for (const type of ACTIVITY) window.addEventListener(type, onActivity, { passive: true, capture: true });
    window.addEventListener("focus", onActivity);
    window.addEventListener("blur", onAway);
    window.addEventListener("pagehide", onAway);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = setInterval(() => void flush(), REPORT_EVERY_MS);
    return () => {
      clearInterval(timer);
      for (const type of ACTIVITY) window.removeEventListener(type, onActivity, { capture: true });
      window.removeEventListener("focus", onActivity);
      window.removeEventListener("blur", onAway);
      window.removeEventListener("pagehide", onAway);
      document.removeEventListener("visibilitychange", onVisibility);
      set.delete(beforeSend);
      if (set.size === 0) flushers.delete(key);
      onAway();
    };
  }, [pr, report]);
}
