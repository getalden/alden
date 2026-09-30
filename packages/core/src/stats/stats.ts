import { type Distribution, type RepoStats, STATS_SCHEMA_VERSION } from "@alden/schema";
import type { GitHubClient } from "../github/client.js";

/** What stats need from one PR. */
export interface StatsPullRequest {
  number: number;
  createdAt: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  author: { login: string; __typename: string } | null;
  /** When it left draft, if it was ever a draft. */
  readyEvents: { createdAt: string }[];
  reviews: { author: { login: string; __typename: string } | null; state: string; submittedAt: string | null }[];
}

const PULL_REQUESTS_QUERY = `query($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number createdAt state isDraft
        author { login __typename }
        timelineItems(itemTypes: [READY_FOR_REVIEW_EVENT], first: 5) { nodes { ... on ReadyForReviewEvent { createdAt } } }
        reviews(first: 50) { nodes { author { login __typename } state submittedAt } }
      }
    }
  }
}`;

interface MergedPage {
  search: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (Omit<StatsPullRequest, "readyEvents" | "reviews"> & {
      timelineItems: { nodes: ({ createdAt: string } | Record<string, never>)[] };
      reviews: { nodes: StatsPullRequest["reviews"] };
    })[];
  };
}

/** GitHub's search returns at most 1,000 results for one query. */
const SEARCH_CAP = 1_000;

const day = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Every PR opened in `repo` between two dates, whatever happened to it since, up to GitHub's search cap. Choosing by
 * the date opened (not merged) keeps slow PRs in: a merged-date window only holds the recent PRs that finished fast.
 */
export async function fetchPullRequestsOpened(
  client: GitHubClient,
  repo: string,
  from: Date,
  to: Date,
): Promise<{ prs: StatsPullRequest[]; truncated: boolean }> {
  const q = `repo:${repo} is:pr created:${day(from)}..${day(to)} sort:created-desc`;
  const prs: StatsPullRequest[] = [];
  let after: string | null = null;
  let total = 0;
  for (;;) {
    const page: MergedPage = await client.graphql<MergedPage>(PULL_REQUESTS_QUERY, { q, first: 50, after });
    total = page.search.issueCount;
    for (const node of page.search.nodes) {
      if (!node || !("number" in node)) continue;
      prs.push({
        number: node.number,
        createdAt: node.createdAt,
        state: node.state,
        isDraft: node.isDraft,
        author: node.author,
        readyEvents: node.timelineItems.nodes.filter((n): n is { createdAt: string } => "createdAt" in n),
        reviews: node.reviews.nodes,
      });
    }
    if (!page.search.pageInfo.hasNextPage || prs.length >= SEARCH_CAP) break;
    after = page.search.pageInfo.endCursor;
  }
  return { prs, truncated: total > prs.length };
}

const HOUR = 3_600_000;
const isBot = (a: { __typename: string; login: string } | null) =>
  a !== null && (a.__typename === "Bot" || a.login.endsWith("[bot]"));

export interface Measured {
  readyAt: Date;
  bot: boolean;
  /** Still a draft: never ready, so not measured. */
  draft: boolean;
  /** Hours to the first review; for an open PR not reviewed yet, its wait so far. Null when it can't be measured. */
  firstReviewHours: number | null;
  approvalHours: number | null;
  waitingForReview: boolean;
  waitingForApproval: boolean;
}

/**
 * One PR's clock: when it was ready for review, and how long until the first review and the first approval. An open
 * PR still waiting counts its wait so far; a merged or closed one without a review isn't measured.
 */
export function measure(pr: StatsPullRequest, now: Date = new Date()): Measured {
  // Opened as a draft and marked ready later: the clock starts at the first "ready for review".
  const ready = pr.readyEvents.map((e) => Date.parse(e.createdAt)).sort((a, b) => a - b)[0];
  const readyAt = new Date(ready ?? Date.parse(pr.createdAt));
  const by = pr.author?.login;
  // Reviews by other people (not the author, not bots) submitted once it was ready.
  const reviews = pr.reviews
    .filter((r) => r.submittedAt && r.author && r.author.login !== by && !isBot(r.author))
    .filter((r) => r.state !== "PENDING" && Date.parse(r.submittedAt as string) >= readyAt.getTime())
    .map((r) => ({ state: r.state, at: Date.parse(r.submittedAt as string) }))
    .sort((a, b) => a.at - b.at);
  const first = reviews[0];
  const approval = reviews.find((r) => r.state === "APPROVED");
  const open = pr.state === "OPEN";
  const soFar = Math.max(0, (now.getTime() - readyAt.getTime()) / HOUR);
  return {
    readyAt,
    bot: isBot(pr.author),
    draft: pr.isDraft,
    firstReviewHours: first ? (first.at - readyAt.getTime()) / HOUR : open ? soFar : null,
    // A closed, unmerged PR was abandoned: how long approval took says nothing.
    approvalHours: approval && pr.state !== "CLOSED" ? (approval.at - readyAt.getTime()) / HOUR : open ? soFar : null,
    waitingForReview: open && !first,
    waitingForApproval: open && !approval,
  };
}

/** Nearest-rank percentile of sorted numbers. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, medianHours: median(sorted), p90Hours: percentile(sorted, 90) };
}

/** The Monday a date's week starts on, as YYYY-MM-DD (UTC). */
export function weekOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return day(d);
}

/** Two weeks: long enough for most reviews, short enough that a recent start with Alden has PRs to judge. */
export const DEFAULT_HORIZON_HOURS = 14 * 24;

/** Turns PRs into the stats a front end shows. */
export function summarizeStats(options: {
  repo: string;
  prs: StatsPullRequest[];
  from: Date;
  to: Date;
  split: RepoStats["split"];
  truncated: boolean;
  now?: Date;
  horizonHours?: number;
}): RepoStats {
  const now = options.now ?? new Date();
  const horizon = options.horizonHours ?? DEFAULT_HORIZON_HOURS;
  const measured = options.prs.map((pr) => measure(pr, now));
  const candidates = measured.filter((m) => !m.bot && !m.draft);
  // Judge only PRs that have had the whole horizon, and cap every wait at it: before and after then get the same
  // stretch of time, and a PR still waiting counts as the full horizon.
  const people = candidates.filter((m) => now.getTime() - m.readyAt.getTime() >= horizon * HOUR);
  const capped = (hours: number | null) => (hours === null ? null : Math.min(hours, horizon));
  const splitAt = options.split ? Date.parse(options.split.at) : undefined;
  const side = (when: "before" | "after") =>
    people.filter(
      (m) =>
        splitAt !== undefined && (when === "before" ? m.readyAt.getTime() < splitAt : m.readyAt.getTime() >= splitAt),
    );

  const values = (list: typeof people, pick: (m: Measured) => number | null) =>
    list.flatMap((m) => {
      const v = capped(pick(m));
      return v === null ? [] : [v];
    });
  const metric = (pick: (m: Measured) => number | null) => ({
    all: distribution(values(people, pick)),
    before: splitAt === undefined ? null : distribution(values(side("before"), pick)),
    after: splitAt === undefined ? null : distribution(values(side("after"), pick)),
  });

  const byWeek = new Map<string, typeof people>();
  for (const m of people) {
    const week = weekOf(m.readyAt);
    byWeek.set(week, [...(byWeek.get(week) ?? []), m]);
  }
  const weeks = [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, list]) => ({
      week,
      prs: list.length,
      timeToFirstReviewMedianHours: distribution(values(list, (m) => m.firstReviewHours)).medianHours,
      cycleTimeMedianHours: distribution(values(list, (m) => m.approvalHours)).medianHours,
    }));

  return {
    schemaVersion: STATS_SCHEMA_VERSION,
    repo: options.repo,
    fetchedAt: now.toISOString(),
    window: { from: options.from.toISOString(), to: options.to.toISOString() },
    split: options.split,
    prs: options.prs.length,
    horizonHours: horizon,
    timeToFirstReview: metric((m) => m.firstReviewHours),
    cycleTime: metric((m) => m.approvalHours),
    weeks,
    excluded: {
      bots: measured.filter((m) => m.bot).length,
      drafts: measured.filter((m) => !m.bot && m.draft).length,
      tooRecent: candidates.length - people.length,
      noReview: people.filter((m) => m.firstReviewHours === null).length,
      noApproval: people.filter((m) => m.approvalHours === null).length,
    },
    stillWaiting: {
      review: people.filter((m) => m.waitingForReview).length,
      approval: people.filter((m) => m.waitingForApproval).length,
    },
    truncated: options.truncated,
  };
}

/**
 * A repo's stats over the last `days`. Before becomes after at `since`, or else at the first time Alden was used on
 * the repo (`firstUse`), or there's no split. Cached for an hour, since GitHub's search is slow for busy repos.
 */
export async function repoStats(
  client: GitHubClient,
  repo: string,
  options: {
    days?: number;
    since?: Date;
    firstUse?: Date;
    cache?: {
      get<T>(key: string, maxAgeMs: number): Promise<T | undefined>;
      set(key: string, value: unknown): Promise<void>;
    };
    refresh?: boolean;
    now?: Date;
    horizonHours?: number;
  } = {},
): Promise<RepoStats> {
  const now = options.now ?? new Date();
  const days = options.days ?? 90;
  const from = new Date(now.getTime() - days * 24 * HOUR);
  const split: RepoStats["split"] = options.since
    ? { at: options.since.toISOString(), source: "since" }
    : options.firstUse
      ? { at: options.firstUse.toISOString(), source: "first-use" }
      : null;

  const key = `stats:v2:${repo.toLowerCase()}:${days}:${day(now)}`;
  const cached = options.refresh
    ? undefined
    : await options.cache?.get<{ prs: StatsPullRequest[]; truncated: boolean }>(key, HOUR);
  const fetched = cached ?? (await fetchPullRequestsOpened(client, repo, from, now));
  if (!cached) await options.cache?.set(key, fetched);
  return summarizeStats({
    repo,
    prs: fetched.prs,
    from,
    to: now,
    split,
    truncated: fetched.truncated,
    now,
    ...(options.horizonHours ? { horizonHours: options.horizonHours } : {}),
  });
}
