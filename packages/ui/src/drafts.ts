import type {
  ReviewDraft as BaseDraft,
  ReviewDrafts as BaseDrafts,
  SendReviewResult as BaseSendResult,
  ReviewEvent,
  UnaddressedPlace,
} from "@alden/schema";
import { linkLines, noteText } from "@alden/schema/note-text";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Api } from "./api";

/*
 * Comment from Alden: the comments you write in a briefing, kept on this machine as drafts until you send them to
 * GitHub as one review. The types are the local API's, from @alden/schema.
 */

/** A draft, with its line range, suggested change and the lines it was placed on (from the schema). */
export type ReviewDraft = BaseDraft;
export type { ReviewEvent };
/**
 * What sending a review answers, and (from engines that learn from reviews) what Alden learned from it, e.g. "you care
 * about callers flags (2 of 3)". Mirrors the engine's optional `learned`.
 */
export type SendReviewResult = BaseSendResult & { learned?: string[] | undefined };
export type Unaddressed = UnaddressedPlace;
export type DraftsResponse = BaseDrafts;

export interface NewDraft {
  path?: string;
  line?: number;
  startLine?: number;
  side?: "RIGHT" | "LEFT";
  body: string;
  suggestion?: string;
}

/** A change to a draft: its text, and its suggestion (`null` takes the suggestion off). */
export interface DraftPatch {
  body: string;
  suggestion?: string | null;
}

/**
 * Where a comment goes: a line (or lines) of a file, or without `line` the whole file. What the diff, the briefing and
 * the guided review hand to `onComment`. `lineText` is the text of the line(s), when known, to start a suggested
 * change from. Anywhere GitHub won't take an inline comment, it's saved as a note in the review body linking there.
 */
export interface CommentPlace {
  path: string;
  line?: number | undefined;
  side: "RIGHT" | "LEFT";
  startLine?: number | undefined;
  lineText?: string | undefined;
}

type Placed = { path?: string | undefined; line?: number | undefined; startLine?: number | undefined };

const range = (d: Placed) => (d.startLine && d.line && d.startLine < d.line ? `${d.startLine}–${d.line}` : undefined);

/** What a linked note links to, in plain words: "links to src/api.ts, line 9", or "links to src/api.ts". */
export const linkedText = (d: Pick<ReviewDraft, "linkTo">) => {
  if (!d.linkTo) return "";
  const lines = linkLines(d.linkTo);
  return `links to ${d.linkTo.path}${lines ? `, ${lines}` : ""}`;
};

/** The tooltip on a linked note: which code its link shows. */
export const linkedTitle = (d: Pick<ReviewDraft, "headSha">) =>
  `The link shows the code at ${d.headSha.slice(0, 7)}, the PR's head when this was written: the code you saw.`;

/** "src/api.ts:9", "src/api.ts:4–9" for lines, or "src/api.ts" for a whole file. */
export const placeText = (d: Placed) => (d.path ? `${d.path}${d.line ? `:${range(d) ?? d.line}` : ""}` : "");

/** In plain words: "src/api.ts, line 9", "src/api.ts, lines 4–9", or "the review body" for a general note. */
export const whereText = (d: Placed) => {
  if (!d.path) return "the review body";
  if (!d.line) return d.path;
  const lines = range(d);
  return lines ? `${d.path}, lines ${lines}` : `${d.path}, line ${d.line}`;
};

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
 * What the review's body says on GitHub: what you wrote for it, then each general note, a blank line between, a
 * linked note starting with its link. (The server builds it with the same `noteText`; the confirmation shows it so
 * what you see is what posts.)
 */
export function reviewBody(body: string, drafts: ReviewDraft[]): string {
  return [body.trim(), ...drafts.filter((d) => !d.path).map(noteText)].filter(Boolean).join("\n\n");
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
  edit(id: string, patch: DraftPatch): Promise<void>;
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
    async edit(id, patch) {
      const saved = await api.editDraft(id, patch);
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

const DRAWER_KEY = "alden.comments.drawer";

/**
 * Whether the Comments drawer is open, remembered for this window (a tab, or the desktop app's window) across reloads.
 * Until you choose, it starts open only when the window has room for it beside the queue and the briefing. In a narrow
 * window, where it's a sheet over the briefing, it always starts closed.
 */
export function useDrawerOpen(): [boolean, (open: boolean | ((was: boolean) => boolean)) => void] {
  const [open, setOpen] = useState(() => {
    if (window.innerWidth <= 700) return false;
    try {
      const saved = window.sessionStorage.getItem(DRAWER_KEY);
      if (saved !== null) return saved === "1";
    } catch {
      // storage blocked: fall back to the window's width
    }
    return window.innerWidth >= 1280;
  });
  const update = useCallback((next: boolean | ((was: boolean) => boolean)) => {
    setOpen((was) => {
      const value = typeof next === "function" ? next(was) : next;
      try {
        window.sessionStorage.setItem(DRAWER_KEY, value ? "1" : "0");
      } catch {
        // storage blocked: the choice lasts for this page
      }
      return value;
    });
  }, []);
  return [open, update];
}
