import type { ReviewThread, ReviewThreads } from "@alden/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Api } from "./api";
import type { ReviewDraft } from "./drafts";

/*
 * The conversation already on a PR: its review threads, read from GitHub through the local API (read only). You reply
 * in a thread, or tick Resolve, as a draft that goes out with your one review; nothing here posts on its own.
 */

export type { ReviewThread, ReviewThreads };

/** A PR's threads as the Comments drawer and the Diff tab show them. */
export interface ThreadsState {
  /** Yours first (started or replied in), then open before resolved, then by file and line. */
  threads: ReviewThread[];
  loading: boolean;
  /** Why they couldn't be read; the threads on screen stay. */
  error: string | undefined;
  /** Reads them again: `refresh` asks GitHub rather than the local API's short cache (after a send). */
  reload(refresh?: boolean): Promise<void>;
}

/** Started a thread, or replied in it. */
export const isYours = (t: ReviewThread) => t.startedByYou || t.comments.some((c) => c.isYou);

/** Yours first, then open before resolved, then by file and line: the order the drawer lists them in. */
export function sortThreads(threads: ReviewThread[]): ReviewThread[] {
  return [...threads].sort(
    (a, b) =>
      Number(isYours(b)) - Number(isYours(a)) ||
      Number(a.isResolved) - Number(b.isResolved) ||
      a.path.localeCompare(b.path) ||
      (a.line ?? a.originalLine ?? 0) - (b.line ?? b.originalLine ?? 0),
  );
}

/** "src/pay.ts:40", "src/pay.ts:38–40" for lines, the line it was started on when outdated, or the file. */
export function threadPlace(t: Pick<ReviewThread, "path" | "line" | "startLine" | "originalLine">): string {
  const line = t.line ?? t.originalLine;
  if (line === null) return t.path;
  return t.line !== null && t.startLine !== null && t.startLine < line
    ? `${t.path}:${t.startLine}–${line}`
    : `${t.path}:${line}`;
}

/** Your reply draft in a thread, if you've started one (one per thread). */
export const replyIn = (drafts: ReviewDraft[], threadId: string) => drafts.find((d) => d.inReplyTo === threadId);

/**
 * Where a reply draft will post, in plain words: "Reply in thread on src/pay.ts:40, and resolve it", or "Resolve the
 * thread on src/pay.ts:40" when it only resolves.
 */
export function replyWhere(draft: Pick<ReviewDraft, "body" | "resolve">, thread: ReviewThread | undefined): string {
  const where = thread ? `thread on ${threadPlace(thread)}` : "a thread";
  if (!draft.body.trim()) return `Resolve the ${where}`;
  return `Reply in ${where}${draft.resolve ? ", and resolve it" : ""}`;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

/** One PR's review threads, read when the PR opens and when the window comes back into focus. */
export function useThreads(api: Pick<Api, "threads"> | undefined, pr: string | undefined): ThreadsState | undefined {
  const [threads, setThreads] = useState<ReviewThread[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const current = useRef(pr);
  current.current = pr;

  const reload = useCallback(
    async (refresh = false) => {
      if (!api || !pr) return;
      try {
        const next = await api.threads(pr, refresh);
        if (current.current !== pr) return;
        setThreads(sortThreads(next.threads));
        setError(undefined);
      } catch (e) {
        if (current.current === pr) setError(`Couldn't read the PR's conversation: ${messageOf(e)}`);
      }
    },
    [api, pr],
  );

  useEffect(() => {
    if (!api || !pr) return;
    setThreads([]);
    setError(undefined);
    setLoading(true);
    reload().finally(() => {
      if (current.current === pr) setLoading(false);
    });
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [api, pr, reload]);

  if (!api || !pr) return undefined;
  return { threads, loading, error, reload };
}
