import type { PrDiffLine } from "@alden/schema";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { sideOf } from "../diff";
import type { BriefingComments } from "../drafts";
import { plural } from "../format";
import { type ReviewThread, replyIn, replyWhere } from "../threads";
import { useReviewActions } from "./Comments";

/*
 * The PR's review threads at their lines in the Diff tab: a folded row under each line that has a conversation, with
 * Reply, which opens that thread's Reply box in the Comments drawer. Read only here; replies are drafts sent with your
 * review. Outdated threads have no line at the head, so they're only in the drawer.
 */

interface ThreadsAt {
  /** Threads by side, path and line at the PR's head. */
  at: Map<string, ReviewThread[]>;
  drafts: BriefingComments["drafts"];
  onReply: ((threadId: string) => void) | undefined;
}

const keyOf = (side: string, path: string, line: number) => `${side}\u0000${path}\u0000${line}`;

const ThreadsContext = createContext<ThreadsAt | undefined>(undefined);

/** Gives the Diff tab the PR's threads (from `comments`, when they're this PR's) and the drawer's Reply. */
export function DiffThreadsProvider(props: {
  comments: BriefingComments | undefined;
  pr: string | undefined;
  children: ReactNode;
}) {
  const { comments, pr } = props;
  const actions = useReviewActions();
  const mine = !!pr && comments?.pr.toLowerCase() === pr.toLowerCase();
  const threads = mine ? comments?.threads?.threads : undefined;
  const drafts = mine ? comments?.drafts : undefined;
  const value = useMemo<ThreadsAt | undefined>(() => {
    if (!threads || threads.length === 0) return undefined;
    const at = new Map<string, ReviewThread[]>();
    for (const t of threads) {
      if (t.line === null) continue;
      const key = keyOf(t.side, t.path, t.line);
      at.set(key, [...(at.get(key) ?? []), t]);
    }
    return { at, drafts: drafts ?? [], onReply: actions?.onReply };
  }, [threads, drafts, actions]);
  return <ThreadsContext.Provider value={value}>{props.children}</ThreadsContext.Provider>;
}

/** Who's in a thread, in a few words: "ana", "ana and you", "ana and 2 others". */
function people(thread: ReviewThread): string {
  const names = [...new Set(thread.comments.map((c) => (c.isYou ? "you" : (c.author ?? "someone"))))];
  if (names.length <= 2) return names.join(" and ");
  return `${names[0]} and ${names.length - 1} others`;
}

/** One thread, folded to who's in it and how many comments; open, every comment and Reply. */
function LineThread({ thread, value }: { thread: ReviewThread; value: ThreadsAt }) {
  const [open, setOpen] = useState(!thread.isResolved);
  const draft = replyIn(value.drafts, thread.id);
  return (
    <div className={`diff-thread${thread.isResolved ? " resolved" : ""}`}>
      <button
        type="button"
        className="link-button small diff-thread-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span> {people(thread)} ·{" "}
        {plural(thread.comments.length, "comment")}
        {thread.isResolved ? " · resolved" : ""}
      </button>
      {open && (
        <>
          {thread.comments.map((c) => (
            <div key={c.id} className="diff-note-draft">
              <span className="faint small">{c.isYou ? "You" : (c.author ?? "A deleted account")}</span>
              <p className="diff-note-body">{c.body}</p>
            </div>
          ))}
          {draft && <p className="faint small">Drafted: {replyWhere(draft, thread)}. It posts with your review.</p>}
          {value.onReply && thread.viewerCanReply && (
            <div>
              <button type="button" className="btn xs" onClick={() => value.onReply?.(thread.id)}>
                {draft?.body.trim() ? "Edit reply" : "Reply"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The threads on one diff line, as a row under it; nothing when it has none. */
export function ThreadsAtLine({ path, line }: { path: string; line: PrDiffLine }) {
  const value = useContext(ThreadsContext);
  const at = sideOf(line);
  const threads = value && at ? value.at.get(keyOf(at.side, path, at.line)) : undefined;
  if (!value || !threads) return null;
  return (
    <tr className="diff-thread-row">
      <td colSpan={4}>
        <div className="diff-note">
          {threads.map((t) => (
            <LineThread key={t.id} thread={t} value={value} />
          ))}
        </div>
      </td>
    </tr>
  );
}
