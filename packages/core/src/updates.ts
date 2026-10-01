import { JsonCache } from "./cache.js";

/** "0.2.0" > "0.1.9", "1.0.0" > "1.0.0-beta.2". Enough for Alden's own versions. */
export function newerVersion(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core = "", pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  if (x.pre === undefined) return y.pre !== undefined;
  if (y.pre === undefined) return false;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true }) > 0;
}

const DAY = 24 * 3_600_000;

/**
 * The newest Alden on npm (its `latest` or `next` tag, whichever is newer), if it's newer than `current`. Asks the
 * registry at most once a day, gives up after 1.5 seconds, and never throws: an update check must not break anything.
 */
export async function checkForUpdate(
  current: string,
  options: { cache?: JsonCache; fetcher?: typeof fetch; refresh?: boolean } = {},
): Promise<string | undefined> {
  const cache = options.cache ?? new JsonCache();
  try {
    let tags = options.refresh ? undefined : await cache.get<Record<string, string>>("update-check:v1", DAY);
    if (!tags) {
      const res = await (options.fetcher ?? fetch)("https://registry.npmjs.org/-/package/alden/dist-tags", {
        signal: AbortSignal.timeout(1_500),
      });
      if (!res.ok) return undefined;
      tags = (await res.json()) as Record<string, string>;
      await cache.set("update-check:v1", tags);
    }
    const newest = Object.values(tags)
      .filter((v) => typeof v === "string")
      .reduce<string | undefined>((best, v) => (best === undefined || newerVersion(v, best) ? v : best), undefined);
    return newest && newerVersion(newest, current) ? newest : undefined;
  } catch {
    return undefined;
  }
}
