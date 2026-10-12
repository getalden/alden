import type { LookHere, ReviewDraft } from "@alden/schema";

/** How far (in lines) a comment can be from a flagged place and still count as about it. */
export const NEAR_LINES = 3;

/** What `isNear` reads of a draft: its place, or the code a linked note links to. A sent comment's place works too. */
export type NearDraft = Pick<ReviewDraft, "path" | "line" | "startLine" | "side" | "linkTo">;

/**
 * Whether a draft (a comment or a suggestion) is about a flagged place: on the same file, within `NEAR_LINES` of its
 * line or range (any line if the place has none).
 */
export function isNear(draft: NearDraft, place: LookHere): boolean {
  // A linked note is about its lines (or its whole file) as much as a comment on them.
  const on = draft.linkTo ?? draft;
  if (!place.anchor || on.path !== place.anchor.path) return false;
  const at = place.anchor.line;
  if (draft.linkTo && on.line === undefined) return true;
  if (on.line === undefined) return false;
  if (at === undefined) return true;
  const first = on.startLine ?? on.line;
  return (draft.side ?? "RIGHT") === "RIGHT" && at >= first - NEAR_LINES && at <= on.line + NEAR_LINES;
}
