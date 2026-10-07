import { createContext, useContext, useEffect, useRef } from "react";

/*
 * The places Alden flagged that you actually saw: a guided review step shown for 1.5 s, or an E1, E2… marker in the
 * Diff tab on screen for 1.5 s. A review that approves without a word on a place you saw teaches Alden a little;
 * a place you never saw teaches it nothing. Sent only to the local API, which keeps them on this machine.
 */

/** How long a place has to be in front of you to count as seen. */
export const SEEN_AFTER_MS = 1_500;
/** How long to wait for more places before sending them, as one request. */
export const SEEN_BATCH_MS = 2_000;
/** The most places in one request (the server takes 50). */
const MAX_BATCH = 50;

export interface SeenPlace {
  checkId?: string;
  path: string;
  line?: number;
  how: "guided" | "diff";
}

export interface SeenBatch {
  pr: string;
  headSha: string;
  places: SeenPlace[];
}

/** Records a place you saw in a PR ("owner/repo#12") at the head commit its briefing is of. */
export type RecordSeen = (pr: string, headSha: string, place: SeenPlace) => void;

/**
 * Collects places as you see them and sends them a moment later, a PR and head at a time. Each place is sent once a
 * page load. Errors are ignored: a place that didn't get recorded only means Alden learns a little less.
 */
export class SeenBatcher {
  private readonly sent = new Set<string>();
  private pending = new Map<string, SeenBatch>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly post: (batch: SeenBatch) => Promise<unknown>,
    private readonly wait = SEEN_BATCH_MS,
  ) {}

  record: RecordSeen = (pr, headSha, place) => {
    const key = `${pr.toLowerCase()}@${headSha}|${place.checkId ?? ""}|${place.path}|${place.line ?? ""}`;
    if (this.sent.has(key)) return;
    this.sent.add(key);
    const group = `${pr.toLowerCase()}@${headSha}`;
    const batch = this.pending.get(group) ?? { pr, headSha, places: [] };
    batch.places.push(place);
    this.pending.set(group, batch);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.wait);
  };

  /** Sends what's waiting now. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batches = [...this.pending.values()];
    this.pending = new Map();
    for (const batch of batches) {
      for (let i = 0; i < batch.places.length; i += MAX_BATCH) {
        try {
          this.post({ ...batch, places: batch.places.slice(i, i + MAX_BATCH) }).catch(() => {});
        } catch {
          // ignored, as above
        }
      }
    }
  }
}

/** Set around the app when there's a local API; absent (as in most tests), nothing is recorded. */
export const SeenContext = createContext<RecordSeen | undefined>(undefined);

export const useRecordSeen = () => useContext(SeenContext);

/**
 * Calls `onSeen` once `key` has been shown for `SEEN_AFTER_MS` without changing, while `shown()` still says it's on
 * screen (not in a hidden tab, the window not hidden). A new key starts the wait again.
 */
export function useSeenAfter(key: string | undefined, shown: () => boolean, onSeen: () => void): void {
  const latest = useRef({ shown, onSeen });
  latest.current = { shown, onSeen };
  useEffect(() => {
    if (key === undefined) return;
    const timer = setTimeout(() => {
      if (latest.current.shown()) latest.current.onSeen();
    }, SEEN_AFTER_MS);
    return () => clearTimeout(timer);
  }, [key]);
}

/** Whether an element is on screen as far as the page can tell: not inside something hidden, the tab not hidden. */
export function onScreen(element: Element | null): boolean {
  if (!element || element.closest("[hidden]")) return false;
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}
