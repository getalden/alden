import type { CiState, RankedPullRequest, RankedQueue } from "@alden/schema";
import {
  activeFilterCount,
  DEFAULT_QUEUE_NAV,
  type NavigatedQueue,
  navigateQueue,
  type QueueFilters,
  type QueueNav,
  type QueueSort,
  queueFacets,
  withFilter,
} from "@alden/schema/queue-nav";
import { type KeyboardEvent, type ReactNode, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { fetchedAgo, formatWait, plural, waitingSince } from "../format";
import { navigate, onLinkClick, routePath } from "../router";
import { Mark } from "./Mark";
import { StateCard } from "./StateCard";

export type Reaction = "up" | "down" | "dismiss";

const CI: Record<CiState, { glyph: string; label: string }> = {
  success: { glyph: "✓", label: "CI" },
  failure: { glyph: "✕", label: "CI" },
  pending: { glyph: "◌", label: "CI" },
  none: { glyph: "–", label: "no CI" },
};

/** Until the server says how close a lesson is. */
const REACTED: Record<Reaction, string> = {
  up: "Noted. More like this.",
  down: "Noted. Fewer like this.",
  dismiss: "Hidden until it changes",
};

export const prKey = (pr: { repo: string; number: number }) => `${pr.repo}#${pr.number}`;

/** Reasons that came from your own feedback ("ranked higher: …") get their own line, not a chip. */
export const isLearnedReason = (reason: string) => /^ranked (higher|lower):/.test(reason);

/** Sort orders as the menu names them; the note under the tools says the rest. */
export const SORT_LABELS: Record<QueueSort, string> = {
  rank: "Alden's rank",
  age: "Open longest",
  waiting: "Waiting longest",
  updated: "Recently updated",
  size: "Smallest first",
};

/** The time the age filter counts from, to the hour, so memoised filtering isn't redone every render. */
export const queueClock = (now = Date.now()) => Math.floor(now / 3_600_000) * 3_600_000;

/** The queue as the filters, search and sort leave it. Memoised: cheap to call on every render, even for 1,000 PRs. */
export function useNavigatedQueue(
  queue: RankedQueue | undefined,
  nav: QueueNav,
  search: string,
  now?: number,
): NavigatedQueue | undefined {
  const clock = queueClock(now);
  return useMemo(
    () => (queue ? navigateQueue(queue, nav, { now: clock, search }) : undefined),
    [queue, nav, search, clock],
  );
}

interface QueueViewProps {
  queue: RankedQueue | undefined;
  error: string | undefined;
  loading: boolean;
  /** Filters and sort; uncontrolled (kept here) when left out. */
  nav?: QueueNav;
  onNav?: (nav: QueueNav) => void;
  /** The search box; uncontrolled when left out. */
  search?: string;
  onSearch?: (search: string) => void;
  /** The queue as `nav` and `search` leave it, when the caller already worked it out (for j/k). */
  view?: NavigatedQueue | undefined;
  /** Changes when `/` is pressed: the search box takes focus. */
  focusSearch?: number;
  /** Collapses the queue to a rail (wide windows only). */
  onCollapse?: () => void;
  onRefresh: () => void;
  selected: string | undefined;
  /** No GitHub sign-in: say how to fix it instead of an error. */
  signedOut?: boolean;
  /** What to show when signed out: the sign-in card (the UI's), else the terminal command. */
  signIn?: ReactNode;
  reactions?: Record<string, Reaction | undefined>;
  onReact?: (key: string, reaction: Reaction) => void;
  /** What each reaction did to learning, by PR: "Dependabot PRs: 2 not useful so far. One more and …". */
  reactionNotes?: Record<string, string | undefined>;
  /** PRs (lowercased "owner/repo#12") with a briefing ready from the desktop app's background run. */
  ready?: Set<string>;
  /** Unsent comments by PR ("owner/repo#12"), for the PRs opened in this window. */
  drafts?: Record<string, number>;
  /** This machine's queue scope, shown so a narrowed queue never looks like an empty one. */
  scope?: { orgs: string[]; repos: string[]; ignore: string[] } | undefined;
  /** For tests: the time the queue's age is measured from. */
  now?: number;
}

/** The PRs waiting on you: "Needs you", ranked, then "Fast-track". Every row says why it ranks where it does. */
export function QueueView({
  queue,
  error,
  loading,
  nav: navProp,
  onNav,
  search: searchProp,
  onSearch,
  view: viewProp,
  focusSearch,
  onCollapse,
  onRefresh,
  selected,
  signedOut = false,
  signIn,
  reactions = {},
  onReact,
  reactionNotes = {},
  ready,
  drafts = {},
  scope,
  now,
}: QueueViewProps) {
  const [showDismissed, setShowDismissed] = useState(false);
  const [ownNav, setOwnNav] = useState(DEFAULT_QUEUE_NAV);
  const [ownSearch, setOwnSearch] = useState("");
  const nav = navProp ?? ownNav;
  const setNav = onNav ?? setOwnNav;
  const search = searchProp ?? ownSearch;
  const setSearch = onSearch ?? setOwnSearch;
  // Typing stays quick on a big queue: the list catches up a moment later.
  const deferredSearch = useDeferredValue(search);
  const ownView = useNavigatedQueue(viewProp ? undefined : queue, nav, deferredSearch, now);
  const view = viewProp ?? ownView;
  const ago = queue ? fetchedAgo(queue.fetchedAt, now) : undefined;
  const needsYou = view?.needsYou ?? [];
  const fastTrack = view?.fastTrack ?? [];
  const dismissed = view?.dismissed ?? [];
  const narrowed = activeFilterCount(nav.filters) > 0 || search.trim() !== "";
  const listRef = useRef<HTMLElement>(null);

  if (signedOut && signIn) return <>{signIn}</>;
  if (signedOut) {
    return (
      <StateCard
        tone="solid"
        glyph="GH"
        title="Sign in to GitHub"
        body="Alden uses your own GitHub sign-in to read the PRs waiting on you. Run this in a terminal, then refresh."
        command="alden auth login"
        action={
          <button type="button" className="btn primary" onClick={onRefresh}>
            I've signed in
          </button>
        }
      />
    );
  }
  if (!queue && loading) {
    return (
      <div aria-busy="true" role="status">
        <div className="list-head">
          <span className="label">Reading your queue…</span>
        </div>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skeleton" />
        ))}
      </div>
    );
  }
  if (!queue && error) {
    return (
      <StateCard
        tone="warn"
        glyph="!"
        title="GitHub didn't answer"
        body={error}
        action={
          <button type="button" className="btn primary" onClick={onRefresh}>
            Retry now
          </button>
        }
      />
    );
  }

  const only = [...(scope?.orgs ?? []), ...(scope?.repos ?? [])];
  const scopeNote =
    only.length || scope?.ignore.length
      ? [only.length ? `Only ${only.join(", ")}` : "", scope?.ignore.length ? `not ${scope.ignore.join(", ")}` : ""]
          .filter(Boolean)
          .join("; ")
      : undefined;

  return (
    <section aria-labelledby="needs-you" ref={listRef}>
      {scopeNote && (
        <p className="side-note faint small scope-note">
          {scopeNote} on this machine.{" "}
          <a href="/settings" onClick={onLinkClick({ view: "settings" })}>
            Change
          </a>
        </p>
      )}
      {ago && (
        <p className="side-note faint small" role="status">
          As of {ago}
          {loading ? ", refreshing…" : ""}
        </p>
      )}
      {queue && (
        <QueueTools
          queue={queue}
          nav={nav}
          onNav={setNav}
          search={search}
          onSearch={setSearch}
          shown={view?.shown ?? 0}
          total={view?.total ?? 0}
          focusSearch={focusSearch}
          onCollapse={onCollapse}
          onRefresh={onRefresh}
          loading={loading}
          list={listRef}
          first={needsYou[0] ?? fastTrack[0]}
        />
      )}
      {error && <p className="banner error side-note">{error}</p>}
      {queue?.warnings.map((w) => (
        <p key={w} className="banner side-note">
          {w}
        </p>
      ))}

      {queue && narrowed && needsYou.length === 0 && fastTrack.length === 0 && (view?.total ?? 0) > 0 && (
        <div className="empty-list">
          <span className="big">No PRs match.</span>
          <span className="muted small">
            {plural(view?.total ?? 0, "PR")} waiting on you, none of them{" "}
            {search.trim() ? `matching "${search.trim()}"` : "matching these filters"}.
          </span>
          <button
            type="button"
            className="link-button small"
            onClick={() => {
              setSearch("");
              setNav({ ...nav, filters: {} });
            }}
          >
            Clear filters
          </button>
        </div>
      )}

      {queue && (view?.total ?? 0) === 0 && (
        <div className="empty-list">
          <Mark size={40} outline />
          <span className="big">Nothing is waiting on you.</span>
          <span className="muted small">No open PRs request your review, directly or through your teams.</span>
          <button type="button" className="link-button small" onClick={onRefresh} disabled={loading}>
            {loading ? "Checking…" : "r to refresh now"}
          </button>
        </div>
      )}

      {needsYou.length > 0 && (
        <>
          <div className="list-head">
            <h2 className="label" id="needs-you">
              Needs you · {needsYou.length}
            </h2>
            <span className="hint">j k move · b brief · + − x react</span>
          </div>
          <ol className="visually-plain" aria-labelledby="needs-you">
            {needsYou.map((row, i) => (
              <li key={prKey(row.pr)}>
                <PrRow
                  row={row}
                  rank={view?.rank.get(prKey(row.pr)) ?? i + 1}
                  selected={selected === prKey(row.pr)}
                  reaction={reactions[prKey(row.pr)]}
                  note={reactionNotes[prKey(row.pr)]}
                  onReact={onReact}
                  ready={ready?.has(prKey(row.pr).toLowerCase()) ?? false}
                  drafts={drafts[prKey(row.pr)] ?? 0}
                />
              </li>
            ))}
          </ol>
        </>
      )}

      {fastTrack.length > 0 && (
        <>
          <div className="list-head lane">
            <h2 className="label" id="fast-track">
              Fast-track · {fastTrack.length}
            </h2>
            <span className="hint">small, low risk, CI green</span>
          </div>
          <ol className="visually-plain" aria-labelledby="fast-track">
            {fastTrack.map((row) => {
              const route = { view: "queue" as const, pr: { repo: row.pr.repo, number: row.pr.number } };
              return (
                <li key={prKey(row.pr)}>
                  <a
                    className="fast-row"
                    href={routePath(route)}
                    onClick={onLinkClick(route)}
                    aria-current={selected === prKey(row.pr) ? "true" : undefined}
                    data-pr={prKey(row.pr)}
                  >
                    <span className="pr-body" style={{ gap: 3 }}>
                      <span className="fast-title" title={row.pr.title}>
                        {row.pr.title}
                      </span>
                      <span className="pr-meta">
                        <span>
                          {row.pr.repo} #{row.pr.number} · {row.fastTrack}
                        </span>
                        {(drafts[prKey(row.pr)] ?? 0) > 0 && (
                          <span className="chip drafts">{plural(drafts[prKey(row.pr)] ?? 0, "draft")}</span>
                        )}
                        <span>
                          <span className="add">+{row.pr.additions}</span>{" "}
                          <span className="del">−{row.pr.deletions}</span>
                        </span>
                      </span>
                    </span>
                    <span className="wait">{formatWait(row.waitingHours)}</span>
                  </a>
                </li>
              );
            })}
          </ol>
        </>
      )}

      {dismissed.length > 0 && (
        <div className="list-foot">
          <span>{dismissed.length} dismissed, until they change ·</span>
          <button type="button" className="link-button" onClick={() => setShowDismissed((v) => !v)}>
            {showDismissed ? "hide" : "show"}
          </button>
        </div>
      )}
      {showDismissed &&
        dismissed.map((row) => (
          <div key={prKey(row.pr)} className="fast-row">
            <span className="pr-body" style={{ gap: 3 }}>
              <span className="fast-title">{row.pr.title}</span>
              <span className="pr-meta">
                {row.pr.repo} #{row.pr.number}
              </span>
            </span>
            {onReact && (
              <button type="button" className="btn xs" onClick={() => onReact(prKey(row.pr), "dismiss")}>
                Undo
              </button>
            )}
          </div>
        ))}
    </section>
  );
}

function PrRow(props: {
  row: RankedPullRequest;
  rank: number;
  selected: boolean;
  reaction: Reaction | undefined;
  note?: string | undefined;
  onReact: ((key: string, reaction: Reaction) => void) | undefined;
  ready?: boolean;
  drafts?: number;
}) {
  const { row, rank, selected, reaction, note, onReact, ready = false, drafts = 0 } = props;
  const { pr } = row;
  const key = prKey(pr);
  const route = { view: "queue" as const, pr: { repo: pr.repo, number: pr.number } };
  const ci = CI[pr.ci];
  // The wait and failing CI have their own places in the row; learned reasons get their own line.
  const learned = row.reasons.find(isLearnedReason);
  const reasons = row.reasons.filter((r) => !/^waiting \d/.test(r) && !/^CI failing/.test(r) && !isLearnedReason(r));
  const react = (r: Reaction) => () => onReact?.(key, r);
  return (
    <div className={`pr-row${selected ? " selected" : ""}${reaction === "dismiss" ? " dismissed" : ""}`} data-pr={key}>
      <span className="pr-rank">{String(rank).padStart(2, "0")}</span>
      <span className="pr-body">
        <a
          className="pr-title stretch"
          href={routePath(route)}
          onClick={onLinkClick(route)}
          aria-current={selected ? "true" : undefined}
        >
          {pr.isDraft && <span className="chip">Draft</span>} {pr.title}
        </a>
        <span className="pr-meta">
          <span>
            {pr.repo} #{pr.number}
          </span>
          <span>{pr.author ?? "ghost"}</span>
          <span>
            <span className="add">+{pr.additions}</span> <span className="del">−{pr.deletions}</span>
          </span>
        </span>
        {(reasons.length > 0 || row.waitingOnAuthor || ready || drafts > 0) && (
          <span className="pr-chips">
            {ready && <span className="chip ready">✓ Briefing ready</span>}
            {drafts > 0 && <span className="chip drafts">{plural(drafts, "draft")}</span>}
            {row.waitingOnAuthor && pr.author && <span className="chip">CI failing: ping @{pr.author}</span>}
            {reasons.map((reason) => (
              <span key={reason} className="chip">
                {reason}
              </span>
            ))}
          </span>
        )}
        {learned && (
          <span className={`learned-line${learned.startsWith("ranked lower") ? " down" : ""}`}>
            <span aria-hidden="true">{learned.startsWith("ranked lower") ? "↓" : "↑"}</span>
            <span>{learned}</span>
          </span>
        )}
        {onReact && (selected || reaction) && (
          <span className="reactions">
            <button
              type="button"
              className={`btn xs${reaction === "up" ? " on" : ""}`}
              aria-pressed={reaction === "up"}
              onClick={react("up")}
            >
              ↑ Useful
            </button>
            <button
              type="button"
              className={`btn xs${reaction === "down" ? " on" : ""}`}
              aria-pressed={reaction === "down"}
              onClick={react("down")}
            >
              ↓ Not useful
            </button>
            <button
              type="button"
              className={`btn xs${reaction === "dismiss" ? " on" : ""}`}
              aria-pressed={reaction === "dismiss"}
              onClick={react("dismiss")}
            >
              × Dismiss
            </button>
            {reaction && (
              <span className="react-note" role="status">
                {(reaction !== "dismiss" && note) || REACTED[reaction]}
              </span>
            )}
          </span>
        )}
      </span>
      <span className="pr-side">
        <span className={`ci ${pr.ci}`} title={`CI ${pr.ci === "none" ? "not set up" : pr.ci}`}>
          {ci.glyph} {ci.label}
        </span>
        <span className={`wait${row.waitingHours >= 24 ? " hot" : ""}`} title={`Waiting ${waitingSince(row)}`}>
          {formatWait(row.waitingHours)}
        </span>
      </span>
    </div>
  );
}

/** One filter menu, styled as a chip: its name when off, its value (highlighted) when on. */
function FilterMenu(props: {
  label: string;
  name: string;
  value: string | undefined;
  options: [value: string, text: string][];
  onChange: (value: string) => void;
}) {
  const { label, name, value = "", onChange } = props;
  // A remembered value the queue no longer has (a label nobody uses now) still shows, so it can be cleared.
  const options =
    value && !props.options.some(([v]) => v === value)
      ? [...props.options, [value, value] as [string, string]]
      : props.options;
  return (
    <select
      className={`chip-select${value ? " on" : ""}`}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{name}</option>
      {options.map(([v, text]) => (
        <option key={v} value={v}>
          {text}
        </option>
      ))}
    </select>
  );
}

const AUTHOR_OPTIONS: [string, string][] = [
  ["you", "By you"],
  ["people", "By people"],
  ["bots", "By bots"],
  ["agents", "By AI agents"],
];
const CI_OPTIONS: [string, string][] = [
  ["passing", "CI passing"],
  ["failing", "CI failing"],
  ["running", "CI running"],
  ["none", "No CI"],
];
const AGE_OPTIONS: [string, string][] = [
  ["today", "Opened today"],
  ["week", "Opened this week"],
  ["older", "Opened before this week"],
];
const DRAFT_OPTIONS: [string, string][] = [
  ["hide", "Hide drafts"],
  ["only", "Only drafts"],
];

/**
 * Above the list: the search box (`/`), the filter menus in one row, and a line with the count, the sort and the way
 * back to everything.
 */
function QueueTools(props: {
  queue: RankedQueue;
  nav: QueueNav;
  onNav: (nav: QueueNav) => void;
  search: string;
  onSearch: (search: string) => void;
  shown: number;
  total: number;
  focusSearch: number | undefined;
  onCollapse: (() => void) | undefined;
  onRefresh: () => void;
  loading: boolean;
  list: { current: HTMLElement | null };
  first: RankedPullRequest | undefined;
}) {
  const { queue, nav, onNav, search, onSearch, shown, total, focusSearch, list, first } = props;
  const facets = useMemo(() => queueFacets(queue), [queue]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusSearch) input.current?.focus();
  }, [focusSearch]);
  const set =
    <K extends keyof QueueFilters>(key: K) =>
    (value: string) =>
      onNav({ ...nav, filters: withFilter(nav.filters, key, value as QueueFilters[K]) });
  const filtersOn = activeFilterCount(nav.filters);
  const narrowed = filtersOn > 0 || search.trim() !== "";
  const changed = narrowed || nav.sort !== "rank";

  // Back to the list: the open PR's row if it's still shown, else the first one. The list may still be catching up
  // with the search (it's deferred), so this waits for a render that has rows, for a moment at most.
  const backToList = useRef(0);
  const focusList = () => {
    const root = list.current;
    const target =
      root?.querySelector<HTMLElement>('[aria-current="true"]') ??
      root?.querySelector<HTMLElement>(".pr-title, .fast-row");
    target?.focus();
    return target !== null && target !== undefined;
  };
  useEffect(() => {
    if (!backToList.current) return;
    if (focusList() || Date.now() - backToList.current > 1000) backToList.current = 0;
  });
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (search) {
        backToList.current = Date.now();
        onSearch("");
      } else if (!focusList()) {
        input.current?.blur();
      }
    } else if (event.key === "Enter" && first) {
      event.preventDefault();
      backToList.current = Date.now();
      navigate({ view: "queue", pr: { repo: first.pr.repo, number: first.pr.number } });
    }
  };

  const reviewerOptions: [string, string][] = [
    ["direct", "Asked you directly"],
    ["teams", "Asked your teams"],
    ...facets.teams.map((t): [string, string] => [t, `Asked ${t}`]),
  ];
  const assigneeOptions: [string, string][] = [
    ["you", "Assigned to you"],
    ["none", "Unassigned"],
    ...facets.assignees
      .filter((a) => a.toLowerCase() !== queue.viewer.toLowerCase())
      .map((a): [string, string] => [a, `Assigned to ${a}`]),
  ];

  return (
    <div className="queue-tools">
      <div className="list-tools">
        <input
          ref={input}
          id="queue-search"
          className="input search"
          type="search"
          placeholder="Search title, repo, #, author, branch"
          aria-label="Search the queue"
          aria-keyshortcuts="/"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {facets.repos.length > 1 && (
          <FilterMenu
            label="Repository"
            name="Repo"
            value={nav.filters.repo}
            options={facets.repos.map((r) => [r, r])}
            onChange={set("repo")}
          />
        )}
        <button
          type="button"
          className="btn sm icon"
          onClick={props.onRefresh}
          disabled={props.loading}
          aria-label={props.loading ? "Refreshing…" : "Refresh"}
          aria-keyshortcuts="r"
          title="Refresh  r"
        >
          <span aria-hidden="true" className={props.loading ? "spin" : undefined}>
            ↻
          </span>
        </button>
        {props.onCollapse && (
          <button
            type="button"
            className="btn sm icon collapse-queue"
            onClick={props.onCollapse}
            aria-label="Collapse the queue"
            aria-keyshortcuts="["
            title="Collapse the queue  ["
          >
            «
          </button>
        )}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset lays its children out in an anonymous box (see Segmented). */}
      <div className="filter-row" role="group" aria-label="Filters">
        <FilterMenu
          label="Author"
          name="Author"
          value={nav.filters.author}
          options={AUTHOR_OPTIONS}
          onChange={set("author")}
        />
        <FilterMenu
          label="Review requested of"
          name="Asked"
          value={nav.filters.reviewer}
          options={reviewerOptions}
          onChange={set("reviewer")}
        />
        <FilterMenu
          label="Assignee"
          name="Assignee"
          value={nav.filters.assignee}
          options={assigneeOptions}
          onChange={set("assignee")}
        />
        {(facets.labels.length > 0 || nav.filters.label) && (
          <FilterMenu
            label="Label"
            name="Label"
            value={nav.filters.label}
            options={facets.labels.map((l) => [l, l])}
            onChange={set("label")}
          />
        )}
        {(facets.hasDrafts || nav.filters.drafts) && (
          <FilterMenu
            label="Drafts"
            name="Drafts"
            value={nav.filters.drafts}
            options={DRAFT_OPTIONS}
            onChange={set("drafts")}
          />
        )}
        <FilterMenu label="CI" name="CI" value={nav.filters.ci} options={CI_OPTIONS} onChange={set("ci")} />
        <FilterMenu label="Opened" name="Age" value={nav.filters.age} options={AGE_OPTIONS} onChange={set("age")} />
      </div>
      <div className="count-row">
        <span className="count" role="status">
          {narrowed ? `${shown} of ${total}` : plural(total, "PR")}
        </span>
        {changed && (
          <button
            type="button"
            className="link-button small"
            onClick={() => {
              onSearch("");
              onNav(DEFAULT_QUEUE_NAV);
            }}
          >
            {narrowed && nav.sort !== "rank" ? "Reset filters and sort" : narrowed ? "Clear filters" : "Reset sort"}
          </button>
        )}
        <label className="sort">
          <span className="faint">Sort</span>
          <select
            className={`chip-select${nav.sort !== "rank" ? " on" : ""}`}
            aria-label="Sort"
            value={nav.sort}
            onChange={(e) => onNav({ ...nav, sort: e.target.value as QueueSort })}
          >
            {(Object.keys(SORT_LABELS) as QueueSort[]).map((s) => (
              <option key={s} value={s}>
                {SORT_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {nav.sort !== "rank" && <p className="sort-note">Sorted within each lane; dismissed stay last.</p>}
    </div>
  );
}
