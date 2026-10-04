/** "45m", "5h", "3d", "2w": how long something has waited, at a glance. */
export function formatWait(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 14) return `${Math.round(days)}d`;
  return `${Math.round(days / 7)}w`;
}

/**
 * The one waiting time a PR shows: since you were asked to review it, or since it opened when GitHub didn't record
 * the request. "8h since you were asked".
 */
export function waitingSince(row: { waitingHours: number; pr: { request: { requestedAt: string | null } } }): string {
  return `${formatWait(row.waitingHours)} since ${row.pr.request.requestedAt ? "you were asked" : "it opened"}`;
}

/** How long ago a queue was fetched, once it's old enough to say: "3 min ago", "2h ago". Undefined under a minute. */
export function fetchedAgo(fetchedAt: string, now: number = Date.now()): string | undefined {
  const minutes = Math.floor((now - Date.parse(fetchedAt)) / 60_000);
  if (!(minutes >= 1)) return undefined;
  if (minutes < 60) return `${minutes} min ago`;
  return `${formatWait(minutes / 60)} ago`;
}

/** "$0.04", "$0.0031", "$12.50". */
export function formatUsd(usd: number): string {
  return `$${usd.toFixed(usd > 0 && usd < 0.01 ? 4 : 2)}`;
}

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/**
 * A link into a PR's "Files changed" view at a file and line. GitHub names each file's diff after the SHA-256 of its
 * path, and a line on the new side as `R<n>`.
 */
export async function prFileUrl(prUrl: string, path: string, line?: number): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prUrl}/files#diff-${hex}${line ? `R${line}` : ""}`;
}
