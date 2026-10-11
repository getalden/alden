import type { FollowUpSummary, PullRequestFacts } from "@alden/schema";

/**
 * Re-reviews, read from facts the queue already has: your reviews on a PR (with the head commit each was on) and when
 * you or one of your teams was last asked. No request of its own. Pure, so the ranking, the CLI and tests share it.
 */

/** The reason a re-review adds to its row; the web UI and the terminal show their own label for it instead. */
export const REREVIEW_REASON = "Re-review: you were asked again";

/** GitHub's state for a review you've started but not submitted: it isn't a review anyone has seen. */
const PENDING = "PENDING";

/**
 * What you've done on a PR before, from `facts`: undefined when `viewer` has never submitted a review on it (only the
 * last 20 reviews are fetched, so on a very busy PR an early review of yours can fall out of sight). Otherwise when
 * you last reviewed, the head commit you reviewed when GitHub says, and `rereviewRequestedAt` when a review was
 * requested from you or one of your teams after that: someone asked you again. Your threads, resolved and replied
 * are 0 here: the queue doesn't read threads, and the follow-ups watcher fills them from its own state.
 */
export function followUpOf(facts: PullRequestFacts, viewer: string): FollowUpSummary | undefined {
  const me = viewer.toLowerCase();
  const last = facts.reviews
    .filter(
      (r): r is typeof r & { submittedAt: string } =>
        r.author?.toLowerCase() === me && r.state !== PENDING && r.submittedAt !== null,
    )
    .sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt))
    .at(-1);
  if (!last) return undefined;
  const asked = facts.request.requestedAt;
  // Submitting a review clears a request for you, so one dated after your review was made again.
  const again = asked !== null && Date.parse(asked) > Date.parse(last.submittedAt);
  return {
    pr: `${facts.repo}#${facts.number}`,
    lastReviewedAt: last.submittedAt,
    ...(last.commit ? { lastReviewedHead: last.commit } : {}),
    ...(again ? { rereviewRequestedAt: asked } : {}),
    yourThreads: 0,
    resolved: 0,
    replied: 0,
  };
}

/** A re-review: you reviewed the PR, and were asked for a review again since. */
export const isRereview = (followUp: FollowUpSummary | undefined): boolean =>
  followUp?.rereviewRequestedAt !== undefined;
