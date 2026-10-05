export interface PrRef {
  repo: string;
  number: number;
}

const URL_FORM = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const SHORT_FORM = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
const RANK_FORM = /^#?(\d+)$/;

/**
 * Reads what the user typed after `alden review`: a PR URL, `owner/repo#123`, or a # from the last `alden queue`
 * (bare numbers mean the queue, as with `alden open`). `lastQueueUrls` is that queue, if there is one.
 */
export function parsePrRef(input: string, lastQueueUrls: string[] | undefined): PrRef {
  const text = input.trim();

  const url = URL_FORM.exec(text);
  if (url) return { repo: url[1] as string, number: Number(url[2]) };

  const short = SHORT_FORM.exec(text);
  if (short) return { repo: short[1] as string, number: Number(short[2]) };

  const rank = RANK_FORM.exec(text);
  if (rank) {
    if (!lastQueueUrls) throw new Error(`Run \`alden queue\` first to use a # from it, or pass owner/repo#number.`);
    const fromQueue = lastQueueUrls[Number(rank[1]) - 1];
    if (!fromQueue) throw new Error(`There's no #${rank[1]} in your last queue (it had ${lastQueueUrls.length}).`);
    return parsePrRef(fromQueue, undefined);
  }

  throw new Error(`"${input}" isn't a PR. Use a GitHub PR URL, owner/repo#123, or a # from \`alden queue\`.`);
}

/**
 * A bare number is a place in the last queue, which isn't the PR with that number: says which PR it picked, and (when
 * this clone is another repo) how to mean PR #n here instead. Undefined for anything but a bare number.
 */
export function queuePick(
  input: string,
  ref: PrRef,
  here: string | undefined,
  command = "alden review",
): string | undefined {
  if (!RANK_FORM.test(input.trim())) return undefined;
  const n = input.trim().replace("#", "");
  let note = `#${n} in your last queue is ${ref.repo}#${ref.number}.`;
  if (here && here.toLowerCase() !== ref.repo.toLowerCase())
    note += ` For PR #${n} in ${here}: ${command} ${here}#${n}`;
  return note;
}
