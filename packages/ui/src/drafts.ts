import type { ReviewDraft, ReviewDrafts, ReviewEvent, SendReviewResult, UnaddressedPlace } from "@alden/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Api } from "./api";

/*
 * Comment from Alden: the comments you write in a briefing, kept on this machine as drafts until you send them to
 * GitHub as one review. The types are the local API's, from @alden/schema.
 */

export type { ReviewDraft, ReviewEvent, SendReviewResult };
export type Unaddressed = UnaddressedPlace;
export type DraftsResponse = ReviewDrafts;

export interface NewDraft {
  path?: string;
  line?: number;
  side?: "RIGHT" | "LEFT";
  body: string;
}

/** "src/api.ts:9", or "src/api.ts" for a whole file. */
export const placeText = (d: { path?: string | undefined; line?: number | undefined }) =>
  d.path ? `${d.path}${d.line ? `:${d.line}` : ""}` : "";

/**
 * Drafts by file, in the order the briefing lists its files (others after, by name), lines in order. General notes
 * come first, under an empty path.
 */
export function groupDrafts(
  drafts: ReviewDraft[],
  fileOrder: string[] = [],
): { path: string; drafts: ReviewDraft[] }[] {
  const groups = new Map<string, ReviewDraft[]>();
  for (const d of drafts) groups.set(d.path ?? "", [...(groups.get(d.path ?? "") ?? []), d]);
  const rank = (path: string) => {
    if (path === "") return -1;
    const i = fileOrder.indexOf(path);
    return i === -1 ? fileOrder.length : i;
  };
  return [...groups]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([path, items]) => ({
      path,
      drafts: [...items].sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || a.createdAt.localeCompare(b.createdAt)),
    }));
}

/**
 * What the review's body says on GitHub: what you wrote for it, then each general note, a blank line between. (The
 * server builds it the same way; the confirmation shows it so what you see is what posts.)
 */
export function reviewBody(body: string, drafts: ReviewDraft[]): string {
  return [body.trim(), ...drafts.filter((d) => !d.path).map((d) => d.body.trim())].filter(Boolean).join("\n\n");
}

/** What GitHub needs before it takes a review, or undefined when it's ready to send. */
export function cannotSend(event: ReviewEvent, body: string, drafts: ReviewDraft[]): string | undefined {
  const outdated = drafts.filter((d) => d.state === "outdated").length;
  if (outdated > 0)
    return `Rewrite or delete ${outdated === 1 ? "the outdated comment" : `the ${outdated} outdated comments`} first.`;
  const text = reviewBody(body, drafts);
  if (event === "REQUEST_CHANGES" && !text) return "Say what to change in the review body.";
  if (event === "COMMENT" && !text && drafts.length === 0) return "Write a comment or a review body first.";
  return undefined;
}

/** Everything the briefing needs to show and change one PR's drafts, and to send them. */
export interface BriefingComments {
  pr: string;
  drafts: ReviewDraft[];
  unaddressed: Unaddressed[];
  loading: boolean;
  /** Why the drafts couldn't be read or changed; the drafts on screen stay. */
  error: string | undefined;
  /** The review's own text and verdict, kept per PR while the window is open. */
  body: string;
  setBody(body: string): void;
  event: ReviewEvent;
  setEvent(event: ReviewEvent): void;
  /** Throws with a message to show by the editor, so its text isn't lost. */
  add(draft: NewDraft): Promise<ReviewDraft>;
  edit(id: string, body: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Reads the drafts again: Claude Code may have added some. */
  reload(): Promise<void>;
  /** Sends every draft as one review. Throws with the server's message, keeping the drafts. */
  send(): Promise<SendReviewResult>;
}

type DraftsApi = Pick<Api, "drafts" | "addDraft" | "editDraft" | "deleteDraft" | "sendReview">;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

/** One PR's drafts, read when the PR opens and again when the window comes back into focus. */
export function useDrafts(api: DraftsApi | undefined, pr: string | undefined): BriefingComments | undefined {
  const [data, setData] = useState<DraftsResponse>({ drafts: [], unaddressed: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<Record<string, ReviewEvent>>({});
  const current = useRef(pr);
  current.current = pr;

  const reload = useCallback(async () => {
    if (!api || !pr) return;
    try {
      const next = await api.drafts(pr);
      if (current.current !== pr) return;
      setData(next);
      setError(undefined);
    } catch (e) {
      if (current.current === pr) setError(`Couldn't read your drafts: ${messageOf(e)}`);
    }
  }, [api, pr]);

  useEffect(() => {
    if (!api || !pr) return;
    setData({ drafts: [], unaddressed: [] });
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
  return {
    pr,
    drafts: data.drafts,
    unaddressed: data.unaddressed,
    loading,
    error,
    body: bodies[pr] ?? "",
    setBody: (body) => setBodies((all) => ({ ...all, [pr]: body })),
    event: events[pr] ?? "COMMENT",
    setEvent: (event) => setEvents((all) => ({ ...all, [pr]: event })),
    async add(draft) {
      const saved = await api.addDraft({ pr, ...draft });
      setData((d) => ({ ...d, drafts: [...d.drafts, saved] }));
      void reload();
      return saved;
    },
    async edit(id, body) {
      const saved = await api.editDraft(id, body);
      setData((d) => ({ ...d, drafts: d.drafts.map((x) => (x.id === id ? saved : x)) }));
    },
    async remove(id) {
      try {
        await api.deleteDraft(id);
      } catch (e) {
        setError(`Couldn't delete that comment: ${messageOf(e)}`);
        throw e;
      }
      setData((d) => ({ ...d, drafts: d.drafts.filter((x) => x.id !== id) }));
      void reload();
    },
    reload,
    async send() {
      const body = bodies[pr]?.trim();
      const result = await api.sendReview({ pr, event: events[pr] ?? "COMMENT", ...(body ? { body } : {}) });
      setData({ drafts: [], unaddressed: [] });
      setBodies(({ [pr]: _, ...rest }) => rest);
      setEvents(({ [pr]: _, ...rest }) => rest);
      return result;
    },
  };
}
