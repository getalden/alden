import type { Anchor, Briefing, FeedbackInput, FeedbackItem, FeedbackTarget } from "@alden/schema";
import { useCallback, useState } from "react";
import type { Api } from "./api";

/** Useful, not useful (both teach Alden about this kind of flag), or dismiss (only hides it on this PR). */
export type Verdict = "agree" | "not_needed" | "dismiss";

/** One flag in one briefing, as the UI tracks it. (The log keys verdicts the same way.) */
export function itemKey(item: FeedbackItem): string {
  const where = item.anchor ? `${item.anchor.path}:${item.anchor.line ?? ""}` : "";
  return [item.placement, item.source, item.checkId ?? "", item.title, where].join("|");
}

const briefingId = (b: Briefing) =>
  `${b.target.kind === "pr" ? `${b.target.repo}#${b.target.number}` : "local"}@${b.generatedAt}`;

export function feedbackTarget(briefing: Briefing, localRepo: string | null): FeedbackTarget {
  return briefing.target.kind === "pr"
    ? { kind: "pr", repo: briefing.target.repo, number: briefing.target.number }
    : { kind: "local", repo: localRepo };
}

export interface BriefingFeedback {
  verdictOf(item: FeedbackItem): Verdict | undefined;
  /** Sets a verdict; the same one again takes it back. */
  toggle(item: FeedbackItem, verdict: Verdict): void;
  reportMissed(note: string, anchor?: Anchor): Promise<void>;
  missedCount: number;
  error: string | undefined;
}

/** Verdicts and misses for every briefing this session, written to the local log as they're given. */
export function useFeedback(api: Api | undefined, localRepo: string | null) {
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [missed, setMissed] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const forBriefing = useCallback(
    (briefing: Briefing): BriefingFeedback => {
      const id = briefingId(briefing);
      const base = {
        target: feedbackTarget(briefing, localRepo),
        briefingAt: briefing.generatedAt,
        ...(briefing.llm?.status === "ok" && briefing.llm.model ? { model: briefing.llm.model } : {}),
      };
      const send = async (input: FeedbackInput) => {
        if (!api) return;
        try {
          await api.addFeedback(input);
          setErrors(({ [id]: _, ...rest }) => rest);
        } catch (error) {
          setErrors((all) => ({ ...all, [id]: `Couldn't save that feedback: ${(error as Error).message}` }));
          throw error;
        }
      };
      return {
        verdictOf: (item) => verdicts[`${id}|${itemKey(item)}`],
        toggle(item, verdict) {
          const key = `${id}|${itemKey(item)}`;
          const previous = verdicts[key];
          const next = previous === verdict ? undefined : verdict;
          setVerdicts(({ [key]: _, ...rest }) => (next ? { ...rest, [key]: next } : rest));
          send({ kind: "verdict", ...base, item, verdict: next ?? "clear" }).catch(() =>
            setVerdicts(({ [key]: _, ...rest }) => (previous ? { ...rest, [key]: previous } : rest)),
          );
        },
        async reportMissed(note, anchor) {
          await send({ kind: "missed", ...base, note, ...(anchor ? { anchor } : {}) });
          setMissed((all) => ({ ...all, [id]: (all[id] ?? 0) + 1 }));
        },
        missedCount: missed[id] ?? 0,
        error: errors[id],
      };
    },
    [api, localRepo, verdicts, missed, errors],
  );

  return forBriefing;
}
