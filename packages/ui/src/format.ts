/** "45m", "5h", "3d", "2w": how long something has waited, at a glance. */
export function formatWait(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 14) return `${Math.round(days)}d`;
  return `${Math.round(days / 7)}w`;
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
