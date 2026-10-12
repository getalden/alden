import {
  type CiState,
  type FollowUpSummary,
  prAuthor,
  type RankedPullRequest,
  type RankedQueue,
  type YourTurnItem,
} from "@alden/schema";
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
import {
  type KeyboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { fetchedAgo, formatWait, plural, waitingSince } from "../format";
import { navigate, onLinkClick, routePath } from "../router";
import { Mark } from "./Mark";
import { StateCard } from "./StateCard";

export type Reaction = "up" | "down" | "dismiss";

/** The CI glyph at the start of a row's mono line, and what it says to a screen reader. */
const CI: Record<CiState, { glyph: string; label: string }> = {
  success: { glyph: "✓", label: "CI passing" },
  failure: { glyph: "✕", label: "CI failing" },
  pending: { glyph: "●", label: "CI running" },
  cancelled: { glyph: "⊘", label: "CI cancelled" },
  none: { glyph: "", label: "no CI" },
};

/** A PR's size as a row flag: L from 400 changed lines, XL from 1,000. Smaller PRs don't say. */
export function sizeFlag(pr: { additions: number; deletions: number }): "L" | "XL" | undefined {
  const lines = pr.additions + pr.deletions;
  return lines >= 1000 ? "XL" : lines >= 400 ? "L" : undefined;
}

/** Until the server says how close a lesson is. */
const REACTED: Record<Reaction, string> = {
  up: "Noted. More like this.",
  down: "Noted. Fewer like this.",
  dismiss: "Hidden until it changes",
};

export const prKey = (pr: { repo: string; number: number }) => `${pr.repo}#${pr.number}`;

/** Reasons that came from your own feedback ("ranked higher: …") get their own line, not a chip. */
export const isLearnedReason = (reason: string) => /^ranked (higher|lower):/.test(reason);
/** "↑ your rule: payments/ first": a rule from Settings → Ranking, marked so it reads as yours. */
export const isRuleReason = (reason: string) => /^[↑↓] your rule:/.test(reason);

/** "Re-review: you were asked again": the row's Re-review label says it, so it isn't repeated as a chip. */
export const isRereviewReason = (reason: string) => /^Re-review:/.test(reason);

/** "2 days ago", "5 hours ago": when you last reviewed, in words. */
export function reviewedAgo(at: string, now: number = Date.now()): string {
  const hours = Math.max(0, (now - Date.parse(at)) / 3_600_000);
  if (hours < 1) return "less than an hour ago";
  if (hours < 24) return `${plural(Math.floor(hours), "hour")} ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${plural(days, "day")} ago`;
  return `${plural(Math.floor(days / 7), "week")} ago`;
}

/**
 * The line a PR you reviewed before gets on its row: "reviewed 2 days ago · 3 of your 5 comments resolved". The
 * counts only show once something has happened to your comments.
 */
export function followUpLine(followUp: FollowUpSummary, now?: number): string {
  const parts = [`reviewed ${reviewedAgo(followUp.lastReviewedAt, now)}`];
  if (followUp.yourThreads > 0 && followUp.resolved > 0) {
    parts.push(`${followUp.resolved} of your ${plural(followUp.yourThreads, "comment")} resolved`);
  }
  if (followUp.replied > 0) parts.push(`${plural(followUp.replied, "reply", "replies")} to you`);
  return parts.join(" · ");
}

/** "3h ago": when the newest of a PR's news happened (or, for a resolve, when Alden saw it). */
export const newsAgo = (at: string, now: number = Date.now()) =>
  `${formatWait(Math.max(0, (now - Date.parse(at)) / 3_600_000))} ago`;

/** Whether news has something not seen in this window (`seen`: the follow-up event ids of the PRs opened here). */
export const unseen = (news: { events: string[] } | undefined, seen: ReadonlySet<string> | undefined) =>
  news?.events.some((id) => !seen?.has(id)) === true;

/**
 * Your turn as the window shows it: a PR you opened here leaves it (the server has its news as seen), except the one
 * open now, which stays put until you move on. Anything newer brings it back.
 */
export function visibleTurns(
  items: YourTurnItem[] | undefined,
  seen: ReadonlySet<string> | undefined,
  selected: string | undefined,
): YourTurnItem[] {
  return (items ?? []).filter((i) => unseen(i.news, seen) || prKey(i) === selected);
}

/** "Sorted by rank": the sort order in the line under the search. */
export const SORT_SHORT: Record<QueueSort, string> = {
  rank: "rank",
  age: "age",
  waiting: "wait",
  updated: "last update",
  size: "size",
};

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
  /** The follow-up events of the PRs opened in this window: seen, so their news leaves Your turn and the rows. */
  seen?: ReadonlySet<string>;
  /** This machine's queue scope, shown so a narrowed queue never looks like an empty one. */
  scope?: { orgs: string[]; repos: string[]; ignore: string[] } | undefined;
  /** For tests: the time the queue's age is measured from. */
  now?: number;
}

/**
 * The queue column: the search and filters, then "Your turn" (news on PRs you reviewed), "Ranked for you", and
 * "Fast-track". Two lines a row: the title and its wait, then a mono line with CI, repo, author and plain flags. The
 * selected row also says why it's there and takes Useful, Not useful and Dismiss.
 */
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
  seen,
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
  const needsYou = view?.needsYou ?? [];
  const fastTrack = view?.fastTrack ?? [];
  const dismissed = view?.dismissed ?? [];
  const narrowed = activeFilterCount(nav.filters) > 0 || search.trim() !== "";
  const listRef = useRef<HTMLElement>(null);
  // Filters and search narrow the queue, not Your turn: it's short, and it's news.
  const turns = visibleTurns(queue?.yourTurn, seen, selected);
  const sorted = nav.sort !== "rank";

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
        <div className="queue-group">
          <span>Reading your queue…</span>
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
    <section className="queue" aria-labelledby={needsYou.length > 0 ? "needs-you" : undefined} ref={listRef}>
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
          now={now}
        />
      )}
      <div className="queue-list">
        {scopeNote && (
          <p className="side-note faint small scope-note">
            {scopeNote} on this machine.{" "}
            <a href="/settings" onClick={onLinkClick({ view: "settings" })}>
              Change
            </a>
          </p>
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

        {turns.length > 0 && (
          <>
            <h2 className="queue-group turn" id="your-turn" title="News on PRs you reviewed">
              <span className="turn-dot" aria-hidden="true" />
              Your turn <span className="n">{turns.length}</span>
            </h2>
            <ol className="visually-plain" aria-labelledby="your-turn">
              {turns.map((item) => (
                <li key={item.pr}>
                  <TurnRow item={item} selected={selected === prKey(item)} now={now} />
                </li>
              ))}
            </ol>
          </>
        )}

        {needsYou.length > 0 && (
          <>
            <h2 className="queue-group" id="needs-you">
              Ranked for you <span className="n">{needsYou.length}</span>
            </h2>
            <ol className="visually-plain" aria-labelledby="needs-you">
              {needsYou.map((row, i) => (
                <li key={prKey(row.pr)}>
                  <PrRow
                    row={row}
                    rank={sorted ? (view?.rank.get(prKey(row.pr)) ?? i + 1) : undefined}
                    selected={selected === prKey(row.pr)}
                    reaction={reactions[prKey(row.pr)]}
                    note={reactionNotes[prKey(row.pr)]}
                    onReact={onReact}
                    ready={ready?.has(prKey(row.pr).toLowerCase()) ?? false}
                    drafts={drafts[prKey(row.pr)] ?? 0}
                    seen={!unseen(row.followUp?.news, seen)}
                    viewer={queue?.viewer}
                    now={now}
                  />
                </li>
              ))}
            </ol>
          </>
        )}

        {fastTrack.length > 0 && (
          <>
            <h2 className="queue-group" id="fast-track" title="Small, low risk, CI green">
              Fast-track <span className="n">{fastTrack.length}</span>
            </h2>
            <ol className="visually-plain" aria-labelledby="fast-track">
              {fastTrack.map((row) => (
                <li key={prKey(row.pr)}>
                  <PrRow
                    row={row}
                    selected={selected === prKey(row.pr)}
                    reaction={undefined}
                    onReact={undefined}
                    drafts={drafts[prKey(row.pr)] ?? 0}
                    viewer={queue?.viewer}
                    fastTrack
                    now={now}
                  />
                </li>
              ))}
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
            <div key={prKey(row.pr)} className="pr-row dismissed-row">
              <span className="row-top">
                <span className="row-title">{row.pr.title}</span>
                {onReact && (
                  <button type="button" className="row-act" onClick={() => onReact(prKey(row.pr), "dismiss")}>
                    Undo
                  </button>
                )}
              </span>
              <span className="row-meta">
                <span className="ci-glyph" aria-hidden="true" />
                <span>
                  {row.pr.repo} #{row.pr.number} · {row.pr.author ?? "ghost"}
                </span>
              </span>
            </div>
          ))}
        {queue && (view?.total ?? 0) > 0 && <p className="queue-foot">j k move · b brief · + − x react</p>}
      </div>
    </section>
  );
}

/** A Your turn row: the PR's title, when the news came, and the news itself in teal. */
function TurnRow({ item, selected, now }: { item: YourTurnItem; selected: boolean; now: number | undefined }) {
  const route = { view: "queue" as const, pr: { repo: item.repo, number: item.number } };
  return (
    <div className={`pr-row turn${selected ? " selected" : ""}`} data-pr={prKey(item)}>
      <span className="row-top">
        <a
          className="row-title stretch"
          href={routePath(route)}
          onClick={onLinkClick(route)}
          aria-current={selected ? "true" : undefined}
          title={item.title}
        >
          {item.title}
        </a>
        <span className="row-age" title={new Date(item.news.at).toLocaleString()}>
          {newsAgo(item.news.at, now).replace(/ ago$/, "")}
        </span>
      </span>
      <span className="row-meta">
        <span className="ci-glyph" aria-hidden="true" />
        <span>
          {item.repo} #{item.number}
        </span>
      </span>
      <span className="row-why">{item.news.text}</span>
    </div>
  );
}

/** The plain flags at the end of a row's mono line. */
function rowFlags(
  row: RankedPullRequest,
  options: { drafts: number; ready: boolean; viewer: string | undefined; fastTrack: boolean },
) {
  const { pr } = row;
  const flags: { text: string; className?: string; title?: string }[] = [];
  if (options.fastTrack && row.fastTrack) flags.push({ text: row.fastTrack });
  if (row.followUp?.rereviewRequestedAt !== undefined) flags.push({ text: "re-review", className: "warn" });
  if (options.drafts > 0) flags.push({ text: `✎ ${options.drafts}`, title: plural(options.drafts, "draft") });
  const size = sizeFlag(pr);
  if (size) flags.push({ text: size, title: `${pr.additions + pr.deletions} lines changed` });
  if (pr.isDraft) flags.push({ text: "draft" });
  const author = prAuthor(pr, options.viewer);
  if (author?.kind === "agent") flags.push({ text: "agent" });
  else if (author?.kind === "bot") flags.push({ text: "bot" });
  if (row.waitingOnAuthor && pr.author)
    flags.push({ text: `ping @${pr.author}`, title: "CI failing: ping the author" });
  if (options.ready) flags.push({ text: "✓ briefed", className: "ok", title: "Briefing ready" });
  return flags;
}

function PrRow(props: {
  row: RankedPullRequest;
  /** Alden's rank, shown when the queue is sorted some other way. */
  rank?: number | undefined;
  selected: boolean;
  reaction: Reaction | undefined;
  note?: string | undefined;
  onReact: ((key: string, reaction: Reaction) => void) | undefined;
  ready?: boolean;
  drafts?: number;
  /** Opened in this window: its news is seen. */
  seen?: boolean;
  viewer?: string | undefined;
  fastTrack?: boolean;
  now?: number | undefined;
}) {
  const { row, rank, selected, reaction, note, onReact, ready = false, drafts = 0 } = props;
  const { pr } = row;
  const key = prKey(pr);
  const route = { view: "queue" as const, pr: { repo: pr.repo, number: pr.number } };
  const ci = CI[pr.ci];
  // The wait and failing CI have their own places in the row; learned reasons get their own line.
  const learned = row.reasons.find(isLearnedReason);
  const reasons = row.reasons.filter(
    (r) => !/^waiting \d/.test(r) && !/^CI failing/.test(r) && !isLearnedReason(r) && !isRereviewReason(r),
  );
  const { followUp } = row;
  // What you haven't seen since your review: in teal under the row, as on Your turn. It stays on the row open now.
  const news = followUp?.news && (!props.seen || selected) ? followUp.news : undefined;
  const reviewedLine =
    followUp &&
    (news ? `reviewed ${reviewedAgo(followUp.lastReviewedAt, props.now)}` : followUpLine(followUp, props.now));
  const flags = rowFlags(row, { drafts, ready, viewer: props.viewer, fastTrack: props.fastTrack === true });
  const react = (r: Reaction) => () => onReact?.(key, r);
  const open = selected || reaction !== undefined;
  return (
    <div className={`pr-row${selected ? " selected" : ""}${reaction === "dismiss" ? " dismissed" : ""}`} data-pr={key}>
      <span className="row-top">
        <a
          className="row-title stretch"
          href={routePath(route)}
          onClick={onLinkClick(route)}
          aria-current={selected ? "true" : undefined}
          title={pr.title}
        >
          {pr.title}
        </a>
        <span className={`row-age${row.waitingHours >= 24 ? " hot" : ""}`} title={`Waiting ${waitingSince(row)}`}>
          {formatWait(row.waitingHours)}
        </span>
      </span>
      <span className="row-meta">
        <span className={`ci-glyph ${pr.ci}`} title={ci.label}>
          {ci.glyph}
          <span className="visually-hidden">{ci.label}</span>
        </span>
        <span>
          {pr.repo} #{pr.number} · {pr.author ?? "ghost"}
        </span>
        {flags.map((f) => (
          <span key={f.text} className={`flag${f.className ? ` ${f.className}` : ""}`} title={f.title}>
            {f.text}
          </span>
        ))}
        {rank !== undefined && (
          <span className="flag rank" title="Alden's rank">
            rank {rank}
          </span>
        )}
      </span>
      {news && <span className="row-why">{news.text}</span>}
      {open && (
        <span className="row-open">
          {selected && learned && (
            <span className={`row-learned${learned.startsWith("ranked lower") ? " down" : ""}`}>
              <span aria-hidden="true">{learned.startsWith("ranked lower") ? "↓" : "↑"}</span> {learned}
            </span>
          )}
          {selected && reasons.length > 0 && <span className="row-reasons">{reasons.join(" · ")}</span>}
          {selected && followUp && reviewedLine && (
            <span className="row-reasons">{news ? reviewedLine : capitalised(reviewedLine)}</span>
          )}
          {onReact && (
            <span className="reactions">
              <button
                type="button"
                className="row-act"
                aria-pressed={reaction === "up"}
                aria-keyshortcuts="+"
                onClick={react("up")}
              >
                Useful
              </button>
              <button
                type="button"
                className="row-act"
                aria-pressed={reaction === "down"}
                aria-keyshortcuts="-"
                onClick={react("down")}
              >
                Not useful
              </button>
              <button
                type="button"
                className="row-act"
                aria-pressed={reaction === "dismiss"}
                aria-keyshortcuts="x"
                onClick={react("dismiss")}
              >
                Dismiss
              </button>
              {reaction && (
                <span className="react-note" role="status">
                  {(reaction !== "dismiss" && note) || REACTED[reaction]}
                </span>
              )}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** One filter: its name beside a menu of values, highlighted when on. */
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
    <label className="filter-field">
      <span>{name}</span>
      <select
        className={`chip-select${value ? " on" : ""}`}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Any</option>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
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
 * Above the list: the search box (`/`), one Filter button whose popover holds every filter and the sort, the collapse
 * button (`[`), and a line saying how the list is sorted and how old it is (click it, or press r, to refresh).
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
  now: number | undefined;
}) {
  const { queue, nav, onNav, search, onSearch, shown, total, focusSearch, list, first } = props;
  const facets = useMemo(() => queueFacets(queue), [queue]);
  const input = useRef<HTMLInputElement>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterButton = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusSearch) input.current?.focus();
  }, [focusSearch]);
  useEffect(() => {
    if (!filtersOpen) return;
    popover.current?.querySelector<HTMLElement>("select")?.focus();
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (popover.current?.contains(target) || filterButton.current?.contains(target)) return;
      setFiltersOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [filtersOpen]);
  const set =
    <K extends keyof QueueFilters>(key: K) =>
    (value: string) =>
      onNav({ ...nav, filters: withFilter(nav.filters, key, value as QueueFilters[K]) });
  const filtersOn = activeFilterCount(nav.filters);
  const narrowed = filtersOn > 0 || search.trim() !== "";
  const changed = narrowed || nav.sort !== "rank";
  const ago = fetchedAgo(queue.fetchedAt, props.now);

  // Back to the list: the open PR's row if it's still shown, else the first one. The list may still be catching up
  // with the search (it's deferred), so this waits for a render that has rows, for a moment at most.
  const backToList = useRef(0);
  const focusList = () => {
    const root = list.current;
    const target =
      root?.querySelector<HTMLElement>('.queue-list [aria-current="true"]') ??
      root?.querySelector<HTMLElement>(".queue-list .row-title.stretch");
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
  const closeFilters = () => {
    setFiltersOpen(false);
    filterButton.current?.focus();
  };
  const onPopoverKey = (event: ReactKeyboardEvent) => {
    // Keys in the popover stay in it: j, k and [ mean other things on the page.
    if (event.key !== "Tab") event.nativeEvent.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      closeFilters();
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
        <span className="search-box">
          <span className="key" aria-hidden="true">
            /
          </span>
          <input
            ref={input}
            id="queue-search"
            className="search"
            type="search"
            placeholder={`Search ${plural(total, "PR")}`}
            aria-label="Search the queue"
            aria-keyshortcuts="/"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </span>
        <button
          ref={filterButton}
          type="button"
          className={`tool-btn${filtersOn > 0 ? " on" : ""}`}
          aria-label={filtersOn > 0 ? `Filter, ${filtersOn} on` : undefined}
          aria-haspopup="dialog"
          aria-expanded={filtersOpen}
          aria-controls={filtersOpen ? "queue-filters" : undefined}
          onClick={() => setFiltersOpen((v) => !v)}
        >
          Filter
          {filtersOn > 0 && <span className="n">{filtersOn}</span>}
        </button>
        {props.onCollapse && (
          <button
            type="button"
            className="tool-btn icon collapse-queue"
            onClick={props.onCollapse}
            aria-label="Collapse the queue"
            aria-keyshortcuts="["
            title="Collapse the queue  ["
          >
            [
          </button>
        )}
        {filtersOpen && (
          <div
            ref={popover}
            id="queue-filters"
            className="filter-popover"
            role="dialog"
            aria-label="Filters"
            onKeyDown={onPopoverKey}
          >
            {/* biome-ignore lint/a11y/useSemanticElements: a fieldset lays its children out in an anonymous box (see Segmented). */}
            <div className="filter-grid" role="group" aria-label="Filters">
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
              <FilterMenu label="CI" name="CI" value={nav.filters.ci} options={CI_OPTIONS} onChange={set("ci")} />
              <FilterMenu
                label="Opened"
                name="Age"
                value={nav.filters.age}
                options={AGE_OPTIONS}
                onChange={set("age")}
              />
              {(facets.repos.length > 1 || nav.filters.repo) && (
                <FilterMenu
                  label="Repository"
                  name="Repo"
                  value={nav.filters.repo}
                  options={facets.repos.map((r) => [r, r])}
                  onChange={set("repo")}
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
              <label className="filter-field">
                <span>Sort</span>
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
            <div className="filter-foot">
              <span className="faint">{narrowed ? `${shown} of ${total}` : plural(total, "PR")}</span>
              {changed && (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    onSearch("");
                    onNav(DEFAULT_QUEUE_NAV);
                  }}
                >
                  {narrowed && nav.sort !== "rank"
                    ? "Reset filters and sort"
                    : narrowed
                      ? "Clear filters"
                      : "Reset sort"}
                </button>
              )}
              <button type="button" className="link-button done" onClick={closeFilters}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="count-row">
        <span className="count" role="status">
          Sorted by {SORT_SHORT[nav.sort]}
          {narrowed ? ` · ${shown} of ${total}` : ""}
        </span>
        {changed && !filtersOpen && (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              onSearch("");
              onNav(DEFAULT_QUEUE_NAV);
            }}
          >
            {narrowed && nav.sort !== "rank" ? "Reset filters and sort" : narrowed ? "Clear filters" : "Reset sort"}
          </button>
        )}
        <button
          type="button"
          className="as-of"
          onClick={props.onRefresh}
          disabled={props.loading}
          aria-keyshortcuts="r"
          title="Refresh  r"
        >
          {props.loading ? (ago ? `as of ${ago}, refreshing…` : "refreshing…") : `as of ${ago ?? "just now"}`}
        </button>
      </div>
      {nav.sort !== "rank" && <p className="sort-note">Sorted within each group; dismissed stay last.</p>}
    </div>
  );
}
