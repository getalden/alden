import { prAuthor } from "./authors.js";
import type { PullRequestFacts, RankedPullRequest, RankedQueue } from "./queue.js";

/**
 * Narrowing and re-sorting a ranked queue: the web UI's search, filters and sort, and `alden queue --author --label
 * --sort --search`. Only looks at facts the queue already has, so it never asks GitHub anything. Ranking itself is
 * untouched: sorting reorders within each lane, and dismissed PRs stay last.
 *
 * No zod here: the web UI imports this file on its own (`@alden/schema/queue-nav`) and shouldn't bundle a validator.
 */

/** Alden's rank, time open (oldest first), waiting on you (longest first), last updated, size (smallest first). */
export const QUEUE_SORTS = ["rank", "age", "waiting", "updated", "size"] as const;
export type QueueSort = (typeof QUEUE_SORTS)[number];

/** Author kinds a filter can name; anything else is a login. */
export const AUTHOR_KINDS = ["you", "people", "bots", "agents"] as const;

export const DRAFT_FILTERS = ["hide", "only"] as const;
export const CI_FILTERS = ["passing", "failing", "running", "none"] as const;
/** Opened today (since local midnight), in the last 7 days, or before that. */
export const AGE_FILTERS = ["today", "week", "older"] as const;

export interface QueueFilters {
  /** owner/name */
  repo?: string;
  /** "you", "people", "bots", "agents", or a login. */
  author?: string;
  /** "direct" (asked by name), "teams" (through any of your teams), or one team as org/slug. */
  reviewer?: string;
  /** "you", "none" (unassigned), or a login. */
  assignee?: string;
  label?: string;
  drafts?: (typeof DRAFT_FILTERS)[number];
  ci?: (typeof CI_FILTERS)[number];
  age?: (typeof AGE_FILTERS)[number];
}

/** What a window remembers: its filters and sort. The search box isn't remembered. */
export interface QueueNav {
  filters: QueueFilters;
  sort: QueueSort;
}

export const DEFAULT_QUEUE_NAV: QueueNav = { filters: {}, sort: "rank" };

const TEXT_FILTERS = ["repo", "author", "reviewer", "assignee", "label"] as const;
const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

/** A remembered QueueNav, checked field by field: anything unknown or malformed is dropped, not trusted. */
export function parseQueueNav(value: unknown): QueueNav {
  if (typeof value !== "object" || value === null) return DEFAULT_QUEUE_NAV;
  const { filters: raw, sort } = value as { filters?: unknown; sort?: unknown };
  const given = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const filters: QueueFilters = {};
  for (const key of TEXT_FILTERS) {
    const v = given[key];
    if (typeof v === "string" && v.trim() && v.length <= 200) filters[key] = v;
  }
  if (isOneOf(DRAFT_FILTERS, given.drafts)) filters.drafts = given.drafts;
  if (isOneOf(CI_FILTERS, given.ci)) filters.ci = given.ci;
  if (isOneOf(AGE_FILTERS, given.age)) filters.age = given.age;
  return { filters, sort: isOneOf(QUEUE_SORTS, sort) ? sort : "rank" };
}

/** True for a sort name `alden queue --sort` and the UI take. */
export const isQueueSort = (value: unknown): value is QueueSort => isOneOf(QUEUE_SORTS, value);

/** The filters with one changed; "" or undefined clears it. */
export function withFilter<K extends keyof QueueFilters>(
  filters: QueueFilters,
  key: K,
  value: QueueFilters[K] | "" | undefined,
): QueueFilters {
  const { [key]: _, ...rest } = filters;
  return value === undefined || value === "" ? rest : { ...rest, [key]: value };
}

/** How many filters are on. */
export function activeFilterCount(filters: QueueFilters): number {
  return Object.values(filters).filter((v) => v !== undefined && v !== "").length;
}

const DAY_MS = 86_400_000;

/** Lowercased text a search matches: title, repo, author, both branches. Built once per PR. */
function haystack(pr: PullRequestFacts): string {
  return [pr.title, pr.repo, pr.author ?? "", pr.headRef, pr.baseRef].join("\n").toLowerCase();
}

/**
 * True when every word of `query` is in the PR's title, repo, author login or branch names. "#123" (or "123") matches
 * PR number 123; "@sam" matches the author sam.
 */
export function matchesSearch(pr: PullRequestFacts, query: string, text = haystack(pr)): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((word) => {
    const number = /^#?(\d+)$/.exec(word);
    if (number && pr.number === Number(number[1])) return true;
    if (word.startsWith("#") && number) return false;
    if (word.startsWith("@") && word.length > 1) return (pr.author ?? "").toLowerCase() === word.slice(1);
    return text.includes(word);
  });
}

function matchesAuthor(pr: PullRequestFacts, author: string, viewer: string): boolean {
  const who = prAuthor(pr, viewer);
  switch (author.toLowerCase()) {
    case "you":
    case "me":
      return who?.kind === "you";
    case "people":
      return who?.kind === "person";
    case "bots":
      return who?.kind === "bot";
    case "agents":
      return who?.kind === "agent";
    default:
      return (pr.author ?? "").toLowerCase() === author.toLowerCase().replace(/^@/, "");
  }
}

function matchesReviewer(pr: PullRequestFacts, reviewer: string): boolean {
  if (reviewer === "direct") return pr.request.direct;
  if (reviewer === "teams") return pr.request.teams.length > 0;
  return pr.request.teams.includes(reviewer.toLowerCase());
}

function matchesAssignee(pr: PullRequestFacts, assignee: string, viewer: string): boolean {
  const assignees = (pr.assignees ?? []).map((a) => a.toLowerCase());
  if (assignee === "none") return assignees.length === 0;
  const login = assignee === "you" ? viewer : assignee.replace(/^@/, "");
  return assignees.includes(login.toLowerCase());
}

const CI_MATCH = { passing: "success", failing: "failure", running: "pending", none: "none" } as const;

/** Local midnight before `now`. */
function startOfDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** A predicate for every filter at once (they combine with AND). */
export function queueFilter(
  filters: QueueFilters,
  options: { viewer: string; now: number; search?: string },
): (row: RankedPullRequest) => boolean {
  const { viewer, now } = options;
  const search = options.search?.trim() ?? "";
  const today = startOfDay(now);
  const weekAgo = now - 7 * DAY_MS;
  return ({ pr }) => {
    if (filters.repo && pr.repo !== filters.repo) return false;
    if (filters.author && !matchesAuthor(pr, filters.author, viewer)) return false;
    if (filters.reviewer && !matchesReviewer(pr, filters.reviewer)) return false;
    if (filters.assignee && !matchesAssignee(pr, filters.assignee, viewer)) return false;
    if (filters.label && !pr.labels.some((l) => l.toLowerCase() === filters.label?.toLowerCase())) return false;
    if (filters.drafts === "hide" && pr.isDraft) return false;
    if (filters.drafts === "only" && !pr.isDraft) return false;
    if (filters.ci && pr.ci !== CI_MATCH[filters.ci]) return false;
    if (filters.age) {
      const opened = Date.parse(pr.createdAt);
      if (filters.age === "today" && opened < today) return false;
      if (filters.age === "week" && opened < weekAgo) return false;
      if (filters.age === "older" && opened >= weekAgo) return false;
    }
    if (search && !matchesSearch(pr, search)) return false;
    return true;
  };
}

const SORT_KEYS: Record<Exclude<QueueSort, "rank">, (row: RankedPullRequest) => number> = {
  age: (r) => Date.parse(r.pr.createdAt),
  waiting: (r) => -r.waitingHours,
  updated: (r) => -Date.parse(r.pr.updatedAt),
  size: (r) => r.pr.additions + r.pr.deletions,
};

/** A lane sorted by `sort`; ties keep Alden's order. Rank leaves it as it is. */
export function sortLane(rows: RankedPullRequest[], sort: QueueSort): RankedPullRequest[] {
  if (sort === "rank") return rows;
  const key = SORT_KEYS[sort];
  return rows
    .map((row, i) => ({ row, i, k: key(row) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.row);
}

export interface NavigatedQueue {
  needsYou: RankedPullRequest[];
  fastTrack: RankedPullRequest[];
  dismissed: RankedPullRequest[];
  /** Needs you plus Fast-track, before any filter or search. */
  total: number;
  /** Needs you plus Fast-track, after them. */
  shown: number;
  /** Alden's rank in Needs you, by PR ("owner/repo#12"), so a re-sorted or filtered row still shows it. */
  rank: Map<string, number>;
}

/** The queue as the filters, search and sort leave it. Each lane is filtered and sorted on its own. */
export function navigateQueue(
  queue: RankedQueue,
  nav: QueueNav,
  options: { now: number; search?: string },
): NavigatedQueue {
  const keep = queueFilter(nav.filters, { viewer: queue.viewer, now: options.now, search: options.search ?? "" });
  const lane = (rows: RankedPullRequest[]) => sortLane(rows.filter(keep), nav.sort);
  const needsYou = lane(queue.needsYou);
  const fastTrack = lane(queue.fastTrack);
  return {
    needsYou,
    fastTrack,
    dismissed: lane(queue.dismissed ?? []),
    total: queue.needsYou.length + queue.fastTrack.length,
    shown: needsYou.length + fastTrack.length,
    rank: new Map(queue.needsYou.map((r, i) => [`${r.pr.repo}#${r.pr.number}`, i + 1])),
  };
}

export interface QueueFacets {
  repos: string[];
  labels: string[];
  assignees: string[];
  teams: string[];
  /** Whether any PR is a draft, so the drafts menu only shows when it would do something. */
  hasDrafts: boolean;
}

/** What the queue's PRs have, dismissed ones included, for the filter menus. Sorted. */
export function queueFacets(queue: RankedQueue): QueueFacets {
  const rows = [...queue.needsYou, ...queue.fastTrack, ...(queue.dismissed ?? [])];
  const sorted = (values: Iterable<string>) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
  return {
    repos: sorted(rows.map((r) => r.pr.repo)),
    labels: sorted(rows.flatMap((r) => r.pr.labels)),
    assignees: sorted(rows.flatMap((r) => r.pr.assignees ?? [])),
    teams: sorted(rows.flatMap((r) => r.pr.request.teams)),
    hasDrafts: rows.some((r) => r.pr.isDraft),
  };
}
