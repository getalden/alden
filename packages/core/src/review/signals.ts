import type {
  Briefing,
  FeedbackItem,
  LookHere,
  ReviewDraft,
  ReviewEvent,
  ReviewSignalEvent,
  ReviewSignalInput,
  ReviewSignalKind,
  Severity,
} from "@alden/schema";
import { FeedbackLog, recordReviewSignals } from "../feedback/log.js";
import { dismissKey, neverQuietened } from "../learn/learn.js";
import type { AldenStore } from "../store/db.js";
import { isNear, NEAR_LINES } from "./near.js";
import { isSevere } from "./pick.js";

/**
 * What a review you send teaches Alden, beyond Useful and Not useful: each place to look in the PR's latest briefing
 * that a comment of yours is near, each place you saw and approved past without a word, and each comment where Alden
 * flagged nothing. Recorded as review signals in the feedback log (see `ReviewSignalEventSchema`); `learn` weighs them.
 */

/** What each signal from a review counts for, in clicks on Useful (or, for a silent pass, on Not useful). */
export const SIGNAL_WEIGHTS = {
  request_changes: 2,
  suggestion: 2,
  comment: 1,
  silent_pass: 0.2,
  miss: 1,
} as const satisfies Partial<Record<ReviewSignalKind, number>>;

/** A place Alden knows you saw: shown in guided review, or scrolled past in the diff. */
export interface SeenPlace {
  checkId?: string;
  path: string;
  line?: number;
  how: "guided" | "diff";
}

/** Reads the places you saw in a PR ("owner/repo#n"), at a head when given. */
export type SeenReader = (store: AldenStore, pr: string, headSha?: string) => SeenPlace[];

/** Nothing known to be seen, so no silent passes: the reader until one that knows is given. */
export const noSeenPlaces: SeenReader = () => [];

/**
 * A place to look as kept for its PR, with the severity of what raised it, so approving past a severe flag never
 * counts against it. Absent on places kept before Alden 0.7, which are then never silent passes.
 */
export type BriefedPlace = LookHere & { severity?: Severity };

/** A briefing's places to look, each with its check's severity (or the model finding's). */
export function briefedPlaces(briefing: Briefing): BriefedPlace[] {
  return briefing.needsYourEyes.map((place) => {
    const severity =
      place.source === "llm"
        ? briefing.llm?.findings.find((f) => f.title === place.title)?.severity
        : briefing.checks?.find((c) => c.id === place.checkId)?.severity;
    return severity ? { ...place, severity } : place;
  });
}

/** Whether you saw a place: the same file, the same check when both say, and near its line when both have one. */
export function wasSeen(place: LookHere, seen: SeenPlace[]): boolean {
  const anchor = place.anchor;
  if (!anchor) return false;
  return seen.some(
    (s) =>
      s.path === anchor.path &&
      (s.checkId === undefined || place.checkId === undefined || s.checkId === place.checkId) &&
      (s.line === undefined || anchor.line === undefined || Math.abs(s.line - anchor.line) <= NEAR_LINES),
  );
}

/** Whether approving past a place may count against its check: never for secrets, AI-aimed text or severe flags. */
const mayPassSilently = (place: BriefedPlace) =>
  place.severity !== undefined &&
  !isSevere(place.severity) &&
  !(place.checkId !== undefined && neverQuietened(place.checkId));

/** A draft's place in the code: its line (or a linked note's), on the new side. */
function whereOf(draft: ReviewDraft): { path: string; line?: number } | undefined {
  if (draft.linkTo)
    return { path: draft.linkTo.path, ...(draft.linkTo.line !== undefined ? { line: draft.linkTo.line } : {}) };
  if (draft.path === undefined) return undefined;
  return {
    path: draft.path,
    ...(draft.line !== undefined && (draft.side ?? "RIGHT") === "RIGHT" ? { line: draft.line } : {}),
  };
}

/**
 * The signals one review gives, before they're recorded. Per place to look (skipping places `yours` says you gave a
 * verdict on yourself, which wins):
 * - a comment near it: `request_changes` when the review requests changes, else `suggestion` when one of the
 *   comments near it suggests a change, else `comment`;
 * - none near it, the review approves, and you saw it (`seen`): `silent_pass`, unless it's severe, its severity is
 *   unknown, or its check is never quietened. Only an approval: a review that only comments, or requests changes
 *   elsewhere, hasn't passed the place.
 *
 * Then a `miss` for each comment on code that no place to look is near.
 */
export function reviewSignals(input: {
  repo: string;
  number: number;
  event: ReviewEvent;
  places: BriefedPlace[];
  drafts: ReviewDraft[];
  seen: SeenPlace[];
  yours?: (place: LookHere) => boolean;
}): Omit<ReviewSignalInput, "at">[] {
  const about = input.drafts.filter((d) => whereOf(d) !== undefined);
  const base = { repo: input.repo, pr: input.number, source: "review" as const };
  const out: Omit<ReviewSignalInput, "at">[] = [];
  for (const place of input.places) {
    if (!place.anchor || input.yours?.(place)) continue;
    const at = {
      ...(place.checkId ? { checkId: place.checkId } : {}),
      path: place.anchor.path,
      ...(place.anchor.line !== undefined ? { line: place.anchor.line } : {}),
    };
    const near = about.filter((d) => isNear(d, place));
    if (near.length > 0) {
      const signal =
        input.event === "REQUEST_CHANGES"
          ? "request_changes"
          : near.some((d) => d.suggestion !== undefined)
            ? "suggestion"
            : "comment";
      out.push({ ...base, ...at, signal, weight: SIGNAL_WEIGHTS[signal] });
    } else if (input.event === "APPROVE" && mayPassSilently(place) && wasSeen(place, input.seen)) {
      out.push({ ...base, ...at, signal: "silent_pass", weight: SIGNAL_WEIGHTS.silent_pass });
    }
  }
  for (const draft of about) {
    if (input.places.some((place) => isNear(draft, place))) continue;
    out.push({ ...base, ...(whereOf(draft) as { path: string }), signal: "miss", weight: SIGNAL_WEIGHTS.miss });
  }
  return out;
}

const placeKey = (s: { checkId?: string | undefined; path?: string | undefined; line?: number | undefined }) =>
  `${s.checkId ?? ""}|${s.path ?? ""}|${s.line ?? ""}`;

/**
 * Records what a sent review taught (see `reviewSignals`), unless `learning.fromReviews` is off (`enabled`, or your
 * user config). A place counts once per PR: a later review of it adds a signal only when it says more (a suggestion
 * after a comment), approving past it after a comment adds nothing, and the same miss isn't counted twice.
 * Returns what was recorded.
 */
export async function learnFromReview(
  store: AldenStore,
  pr: { repo: string; number: number; headSha?: string },
  event: ReviewEvent,
  briefed: { briefingAt: string; places: BriefedPlace[] },
  drafts: ReviewDraft[],
  options: { enabled?: boolean; seen?: SeenReader; now?: Date } = {},
): Promise<ReviewSignalEvent[]> {
  if (options.enabled === false) return [];
  const log = new FeedbackLog(store);
  const target = `${pr.repo.toLowerCase()}#${pr.number}`;
  const verdicts = new Map<string, string>();
  for (const e of await log.events(pr.repo)) {
    if (e.kind !== "verdict" || e.target.kind !== "pr" || e.target.number !== pr.number) continue;
    verdicts.set(dismissKey(target, e.item), e.verdict);
  }
  const yours = (place: LookHere) => {
    const item: Pick<FeedbackItem, "source" | "checkId" | "title" | "anchor"> = {
      source: place.source ?? "check",
      ...(place.checkId ? { checkId: place.checkId } : {}),
      title: place.title,
      ...(place.anchor ? { anchor: place.anchor } : {}),
    };
    const verdict = verdicts.get(dismissKey(target, item));
    return verdict !== undefined && verdict !== "clear";
  };
  let seen: SeenPlace[] = [];
  try {
    seen = (options.seen ?? noSeenPlaces)(store, `${pr.repo}#${pr.number}`, pr.headSha);
  } catch {
    // Not knowing what you saw only means no silent passes.
  }
  const before = log.signals(pr.repo).filter((s) => s.pr === pr.number && s.source === "review");
  const fresh = reviewSignals({
    repo: pr.repo,
    number: pr.number,
    event,
    places: briefed.places,
    drafts,
    seen,
    yours,
  }).filter((signal) => {
    const same = before.filter((s) => placeKey(s) === placeKey(signal));
    if (signal.signal === "silent_pass" || signal.signal === "miss") return same.length === 0;
    return !same.some((s) => s.signal !== "silent_pass" && s.signal !== "miss" && s.weight >= signal.weight);
  });
  return recordReviewSignals(fresh, {
    store,
    ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}
