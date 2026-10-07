import { type AldenStore, checkOutcomes, type GitHubClient, signalsEvent, track } from "@alden/core";

/**
 * Asks GitHub what came of the comments you sent (see `checkOutcomes`), and counts any new outcomes in usage stats by
 * kind only (`review_signals` with `source: "outcome"`), if you opted in.
 */
export async function checkSentOutcomes(client: GitHubClient, store: AldenStore) {
  const result = await checkOutcomes(client, store);
  if (result.recorded.length > 0) void track("review_signals", signalsEvent(result.recorded, "outcome"));
  return result;
}
