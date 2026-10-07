import type { PrDiff, PrDiffFile, PrDiffLine } from "@alden/schema";
import {
  createContext,
  type MouseEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type CommentPlace,
  cachedDiff,
  commentPlace,
  type DiffDraft,
  type DiffPlace,
  fileCounts,
  type LineRef,
  lineCount,
  type Markers,
  placeMarkers,
  placeOrder,
  rangeRows,
  rowFinder,
  rowKey,
  sideOf,
} from "../diff";
import { plural, prFileUrl } from "../format";
import { StateCard } from "./StateCard";

export type { CommentPlace, DiffDraft, DiffPlace };

/**
 * Set around the briefing when it has a Diff tab: a place's file:line then opens the diff there (its GitHub link stays
 * beside it).
 */
export const ShowInDiffContext = createContext<
  ((place: { path: string; line?: number | undefined }) => void) | undefined
>(undefined);

/** Files with more diff lines than this start collapsed, with Show. */
export const COLLAPSE_OVER = 400;
/** Rows rendered together once they near the screen; until then, a placeholder of about their height. */
const CHUNK = 120;
const ROW_HEIGHT = 20;

export interface DiffViewProps {
  diff: PrDiff;
  /**
   * Called when you pick a line (click its +) or a range (shift-click a second line, or drag, on the same side of the
   * same hunk). Without it, lines can't be picked and the + is hidden.
   */
  onComment?: ((place: CommentPlace) => void) | undefined;
  /** Comments to mark at their lines: a badge that shows the text on hover or click. */
  drafts?: DiffDraft[] | undefined;
  /** Alden's places to look, marked E1, E2… at their lines; ] and [ go from one to the next. */
  places?: DiffPlace[] | undefined;
  /** Scrolls to this file (and line) and highlights it, whenever a new object is passed. */
  focus?: { path: string; line?: number | undefined } | undefined;
  /** The PR on GitHub, to link files whose diff is too large to show here. Absent for local changes. */
  prUrl?: string | undefined;
  /** Files with more diff lines than this start collapsed. */
  collapseOver?: number | undefined;
}

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName));

const STATUS: Record<PrDiffFile["status"], string | undefined> = {
  added: "Added",
  removed: "Removed",
  renamed: "Renamed",
  modified: undefined,
};

const SIGN: Record<PrDiffLine["kind"], string> = { add: "+", del: "−", ctx: " " };
const SPOKEN: Record<PrDiffLine["kind"], string> = { add: "Added: ", del: "Removed: ", ctx: "" };

const who = (source: string) => (source === "claude" ? "Claude" : "You");

/** What a row knows about its line and its markers; primitives and stable lists, so unchanged rows don't render. */
interface RowProps {
  line: PrDiffLine;
  at: LineRef;
  places: DiffPlace[] | undefined;
  drafts: DiffDraft[] | undefined;
  selected: boolean;
  highlighted: boolean;
  noteOpen: boolean;
  commentable: boolean;
  actions: RowActions;
}

interface RowActions {
  pickByKey: (at: LineRef, shift: boolean) => void;
  startDrag: (at: LineRef, shift: boolean) => void;
  toggleNote: (key: string) => void;
}

const DiffRow = memo(function DiffRow({
  line,
  at,
  places,
  drafts,
  selected,
  highlighted,
  noteOpen,
  commentable,
  actions,
}: RowProps) {
  const key = rowKey(at);
  const where = sideOf(line);
  const noteId = `diff-note-${key.replaceAll(":", "-")}`;
  const hasNote = (places?.length ?? 0) + (drafts?.length ?? 0) > 0;
  return (
    <>
      <tr
        className={`dl ${line.kind}${selected ? " sel" : ""}${highlighted ? " hl" : ""}`}
        data-row={key}
        aria-selected={selected || undefined}
      >
        <td className="ln">{line.oldLine ?? ""}</td>
        <td className="ln">{line.newLine ?? ""}</td>
        <td className="gut">
          <div className="gut-in">
            {places?.map((p) => (
              <button
                key={`p${p.index}`}
                type="button"
                className="diff-place"
                title={p.title}
                aria-label={`Place E${p.index}: ${p.title}`}
                aria-expanded={noteOpen}
                aria-controls={noteOpen ? noteId : undefined}
                onClick={() => actions.toggleNote(key)}
              >
                E{p.index}
              </button>
            ))}
            {drafts && drafts.length > 0 && (
              <button
                type="button"
                className={`diff-draft${drafts.some((d) => d.state === "outdated") ? " outdated" : ""}`}
                title={drafts.map((d) => `${who(d.source)}: ${d.body}`).join("\n\n")}
                aria-label={`${plural(drafts.length, "comment")} on this line`}
                aria-expanded={noteOpen}
                aria-controls={noteOpen ? noteId : undefined}
                onClick={() => actions.toggleNote(key)}
              >
                <span aria-hidden="true">✎</span>
                {drafts.length > 1 ? drafts.length : ""}
              </button>
            )}
            {commentable && where && (
              <button
                type="button"
                className="diff-plus"
                title="Comment on this line. Shift-click another line, or drag, for a range."
                aria-label={`Comment on ${where.side === "LEFT" ? "removed " : ""}line ${where.line}`}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  actions.startDrag(at, e.shiftKey);
                }}
                onClick={(e) => {
                  // A mouse click was handled on mouse down and up; this is Enter or Space.
                  if (e.detail === 0) actions.pickByKey(at, e.shiftKey);
                }}
              >
                +
              </button>
            )}
          </div>
        </td>
        <td className="code">
          <span className="sign" aria-hidden="true">
            {SIGN[line.kind]}
          </span>
          <span className="visually-hidden">{SPOKEN[line.kind]}</span>
          {line.text}
        </td>
      </tr>
      {noteOpen && hasNote && (
        <tr className="diff-note-row">
          <td colSpan={4}>
            <div className="diff-note" id={noteId}>
              {places?.map((p) => (
                <p key={`p${p.index}`}>
                  <span className="diff-place static">E{p.index}</span> {p.title}
                </p>
              ))}
              {drafts?.map((d, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: drafts on one line have no other stable key here.
                <div key={i} className="diff-note-draft">
                  <span className="faint small">
                    {who(d.source)}
                    {d.startLine !== undefined && d.line !== undefined ? ` · lines ${d.startLine}–${d.line}` : ""}
                    {d.state === "outdated" ? " · outdated" : ""}
                  </span>
                  <p className="diff-note-body">{d.body}</p>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
});

type Item = { type: "hunk"; hunk: number; header: string } | { type: "line"; at: LineRef; line: PrDiffLine };

function itemsOf(file: PrDiffFile, fileIndex: number): Item[] {
  const items: Item[] = [];
  file.hunks.forEach((h, hunk) => {
    items.push({ type: "hunk", hunk, header: h.header });
    h.lines.forEach((line, row) => {
      items.push({ type: "line", at: { file: fileIndex, hunk, row }, line });
    });
  });
  return items;
}

/** Calls back once when `element` comes within a screen or so of view; at once where there's no IntersectionObserver. */
function useNearView(element: Element | null, skip: boolean): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (near || skip || !element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, near, skip]);
  return near || skip;
}

interface ChunkProps {
  items: Item[];
  force: boolean;
  markers: Markers;
  selection: Set<string>;
  highlight: string | undefined;
  notes: Set<string>;
  commentable: boolean;
  actions: RowActions;
}

/** A run of rows, rendered once it nears the screen (or at once when it holds the row being jumped to). */
function Chunk({ items, force, markers, selection, highlight, notes, commentable, actions }: ChunkProps) {
  const [placeholder, setPlaceholder] = useState<HTMLTableRowElement | null>(null);
  const shown = useNearView(placeholder, force);
  if (!shown) {
    return (
      <tbody>
        <tr ref={setPlaceholder} className="diff-placeholder" style={{ height: items.length * ROW_HEIGHT }}>
          <td colSpan={4} />
        </tr>
      </tbody>
    );
  }
  return (
    <tbody>
      {items.map((item) => {
        if (item.type === "hunk") {
          return (
            <tr key={`h${item.hunk}`} className="hunk">
              <td className="ln" colSpan={2} aria-hidden="true">
                ⋯
              </td>
              <td className="hunk-head" colSpan={2}>
                {item.header}
              </td>
            </tr>
          );
        }
        const key = rowKey(item.at);
        const marks = markers.rows.get(key);
        return (
          <DiffRow
            key={key}
            line={item.line}
            at={item.at}
            places={marks?.places.length ? marks.places : undefined}
            drafts={marks?.drafts.length ? marks.drafts : undefined}
            selected={selection.has(key)}
            highlighted={highlight === key}
            noteOpen={notes.has(key)}
            commentable={commentable}
            actions={actions}
          />
        );
      })}
    </tbody>
  );
}

/** A link to a file's diff on GitHub, worked out when it's shown (GitHub names it by a hash of the path). */
function GitHubFileLink({ prUrl, path, children }: { prUrl: string; path: string; children: ReactNode }) {
  const [href, setHref] = useState<string>();
  useEffect(() => {
    let live = true;
    prFileUrl(prUrl, path).then(
      (url) => live && setHref(url),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [prUrl, path]);
  return href ? (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ) : null;
}

interface FileProps {
  file: PrDiffFile;
  index: number;
  collapsed: boolean;
  onToggle: (index: number) => void;
  markers: Markers;
  selection: Set<string>;
  highlight: string | undefined;
  notes: Set<string>;
  commentable: boolean;
  actions: RowActions;
  prUrl: string | undefined;
  collapseOver: number;
}

function DiffFileSection(props: FileProps) {
  const { file, index, collapsed, markers } = props;
  const bodyId = useId();
  const counts = fileCounts(file);
  const lines = lineCount(file);
  const items = useMemo(() => itemsOf(file, index), [file, index]);
  const chunks = useMemo(() => {
    const out: Item[][] = [];
    for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
    return out;
  }, [items]);
  const fileMarks = markers.files.get(index);
  const status = STATUS[file.status];

  let notice: ReactNode;
  if (file.binary) notice = "A binary file. There are no lines to show.";
  else if (file.patchMissing) {
    notice = (
      <>
        This file's diff is too large for GitHub to send, so it can't be shown here.{" "}
        {props.prUrl && (
          <GitHubFileLink prUrl={props.prUrl} path={file.path}>
            Open it on GitHub ↗
          </GitHubFileLink>
        )}
      </>
    );
  } else if (file.hunks.length === 0) {
    notice = file.status === "renamed" ? "Moved without changes." : "No lines changed.";
  }

  return (
    <section className="diff-file" data-file={index} aria-label={file.path}>
      <header className="diff-file-head">
        <button
          type="button"
          className="diff-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => props.onToggle(index)}
        >
          <span className="caret" aria-hidden="true">
            {collapsed ? "▸" : "▾"}
          </span>
          <span className="diff-path">
            {file.previousPath ? (
              <>
                <span className="faint">{file.previousPath}</span>
                <span aria-hidden="true"> → </span>
                <span className="visually-hidden"> renamed to </span>
                {file.path}
              </>
            ) : (
              file.path
            )}
          </span>
        </button>
        <span className="diff-file-meta">
          {fileMarks?.places.map((p) => (
            <span key={`p${p.index}`} className="diff-place static" title={p.title}>
              E{p.index}
            </span>
          ))}
          {fileMarks && fileMarks.drafts.length > 0 && (
            <span
              className="diff-draft static"
              title={fileMarks.drafts.map((d) => `${who(d.source)}: ${d.body}`).join("\n\n")}
            >
              ✎ {fileMarks.drafts.length}
            </span>
          )}
          {status && <span className="chip">{status}</span>}
          <span className="mono small">
            <span className="add">+{counts.additions}</span> <span className="del">−{counts.deletions}</span>
          </span>
        </span>
      </header>
      <div id={bodyId} hidden={collapsed}>
        {notice ? (
          <p className="diff-notice">{notice}</p>
        ) : (
          !collapsed && (
            <div className="diff-scroll">
              <table className="diff-table">
                <caption className="visually-hidden">Changes to {file.path}</caption>
                <colgroup>
                  <col className="c-ln" />
                  <col className="c-ln" />
                  <col className="c-gut" />
                  <col />
                </colgroup>
                <thead className="visually-hidden">
                  <tr>
                    <th scope="col">Old line</th>
                    <th scope="col">New line</th>
                    <th scope="col">Notes</th>
                    <th scope="col">Code</th>
                  </tr>
                </thead>
                {chunks.map((chunk) => {
                  const first = chunk[0];
                  const id = first?.type === "line" ? rowKey(first.at) : `h${first?.hunk}`;
                  const force =
                    props.highlight !== undefined &&
                    chunk.some((item) => item.type === "line" && rowKey(item.at) === props.highlight);
                  return (
                    <Chunk
                      key={id}
                      items={chunk}
                      force={force}
                      markers={markers}
                      selection={props.selection}
                      highlight={props.highlight}
                      notes={props.notes}
                      commentable={props.commentable}
                      actions={props.actions}
                    />
                  );
                })}
              </table>
            </div>
          )
        )}
      </div>
      {collapsed && !notice && lines > props.collapseOver && (
        <p className="diff-notice">
          {plural(lines, "line")} of diff, collapsed to keep things quick.{" "}
          <button type="button" className="link-button" onClick={() => props.onToggle(index)}>
            Show
          </button>
        </p>
      )}
    </section>
  );
}

const EMPTY_SET = new Set<string>();

/**
 * A PR's diff (or your local changes), unified, file by file: old and new line numbers, Alden's places (E1, E2…) and
 * your comments in the gutter, and a + on each line to comment on it when the pane takes comments. Large diffs stay
 * quick: rows render as they near the screen, and files over `collapseOver` lines start collapsed.
 *
 * Keys, while it's shown and you're not typing: ] and [ go to the next and previous place, f collapses or expands the
 * file you're in.
 */
export function DiffView(props: DiffViewProps) {
  const { diff, onComment, focus } = props;
  const collapseOver = props.collapseOver ?? COLLAPSE_OVER;
  const root = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(
    () => new Set(diff.files.flatMap((f, i) => (lineCount(f) > collapseOver ? [i] : []))),
  );
  const [highlight, setHighlight] = useState<string>();
  const [current, setCurrent] = useState<{ file: number; place: number }>({ file: -1, place: -1 });
  const [scrollTo, setScrollTo] = useState<{ file: number; row?: string; nonce: number }>();
  const [notes, setNotes] = useState<Set<string>>(EMPTY_SET);
  const [pick, setPick] = useState<{ from: LineRef; to: LineRef }>();
  const [drag, setDrag] = useState<{ from: LineRef; to: LineRef }>();
  /** Read out to screen readers: where ] and [ went. */
  const [said, setSaid] = useState("");
  /** Shown: a place or file that isn't in the diff. */
  const [notice, setNotice] = useState("");

  const markers = useMemo(() => placeMarkers(diff, props.places, props.drafts), [diff, props.places, props.drafts]);
  const order = useMemo(() => placeOrder(diff, props.places), [diff, props.places]);
  const span = drag ?? pick;
  const selection = useMemo(() => (span ? rangeRows(diff, span.from, span.to) : EMPTY_SET), [diff, span]);

  const totals = useMemo(
    () =>
      diff.files.reduce(
        (sum, f) => {
          const c = fileCounts(f);
          return { additions: sum.additions + c.additions, deletions: sum.deletions + c.deletions };
        },
        { additions: 0, deletions: 0 },
      ),
    [diff],
  );

  const toggle = useCallback((index: number) => {
    setCollapsed((was) => {
      const next = new Set(was);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  /** Opens the file, highlights the row (or the file), and scrolls there. */
  const goTo = useCallback((file: number, ref?: LineRef) => {
    setCollapsed((was) => {
      if (!was.has(file)) return was;
      const next = new Set(was);
      next.delete(file);
      return next;
    });
    const row = ref ? rowKey(ref) : undefined;
    setHighlight(row);
    setCurrent((c) => ({ ...c, file }));
    setScrollTo((s) => ({ file, ...(row ? { row } : {}), nonce: (s?.nonce ?? 0) + 1 }));
  }, []);

  useEffect(() => {
    if (!scrollTo) return;
    const container = root.current;
    const fileEl = container?.querySelector<HTMLElement>(`[data-file="${scrollTo.file}"]`);
    const rowEl = scrollTo.row ? container?.querySelector<HTMLElement>(`[data-row="${scrollTo.row}"]`) : null;
    const target = rowEl ?? fileEl;
    const focusable = rowEl?.querySelector<HTMLElement>("button") ?? fileEl?.querySelector<HTMLElement>(".diff-toggle");
    focusable?.focus({ preventScroll: true });
    // Rows near the target render as it comes into view and change the heights above it, so it's placed again
    // until they've settled (a few frames). No smooth scrolling: it would aim at where the row was.
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const place = () => {
      target?.scrollIntoView?.({ block: rowEl ? "center" : "start" });
      if (++tries < 6) timer = setTimeout(place, 50);
    };
    place();
    return () => clearTimeout(timer);
  }, [scrollTo]);

  // Someone else (a place's link in the briefing, guided review) asks for a file and line.
  useEffect(() => {
    if (!focus) return;
    const file = diff.files.findIndex((f) => f.path === focus.path);
    if (file === -1) {
      setNotice(`${focus.path} isn't in this diff.`);
      return;
    }
    const ref = focus.line !== undefined ? rowFinder(diff)(focus.path, focus.line) : undefined;
    setNotice(
      focus.line !== undefined && !ref
        ? `Line ${focus.line} of ${focus.path} isn't in the diff; showing the file.`
        : "",
    );
    goTo(file, ref);
  }, [focus, diff, goTo]);

  const jump = useCallback(
    (step: 1 | -1) => {
      if (order.length === 0) {
        setNotice("No places to look in this diff.");
        return;
      }
      const at = current.place === -1 ? (step === 1 ? 0 : order.length - 1) : current.place + step;
      const next = (at + order.length) % order.length;
      const entry = order[next];
      if (!entry) return;
      setCurrent({ file: entry.file, place: next });
      setNotice("");
      setSaid(`E${entry.place.index}, ${next + 1} of ${order.length}: ${entry.place.title}`);
      goTo(entry.file, entry.ref);
    },
    [order, current.place, goTo],
  );

  // ] and [ for places, f for the file you're in. On the document, before the window's own keys ([ also folds the
  // queue there), and only while this diff is on screen.
  const keys = useRef({ jump, toggle, current });
  keys.current = { jump, toggle, current };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      if (!root.current || root.current.closest("[hidden]")) return;
      if (event.key === "]") keys.current.jump(1);
      else if (event.key === "[") keys.current.jump(-1);
      else if (event.key === "f") {
        const active = document.activeElement;
        const inFile =
          active instanceof Element && root.current.contains(active) ? active.closest("[data-file]") : null;
        const file = inFile ? Number(inFile.getAttribute("data-file")) : keys.current.current.file;
        if (file < 0 || Number.isNaN(file)) return;
        keys.current.toggle(file);
        root.current.querySelector<HTMLElement>(`[data-file="${file}"] .diff-toggle`)?.focus();
      } else return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Picking lines for a comment: a click, a shift-click after another line, or a drag.
  const latest = useRef({ diff, onComment, pick, drag });
  latest.current = { diff, onComment, pick, drag };
  const finish = useCallback((from: LineRef | undefined, to: LineRef) => {
    const { diff, onComment } = latest.current;
    const place = commentPlace(diff, to, from);
    if (!place || !onComment) return;
    const start = from && place.startLine !== undefined ? from : to;
    setPick({ from: start, to });
    onComment(place);
  }, []);
  const actions = useMemo<RowActions>(
    () => ({
      pickByKey: (at, shift) => finish(shift ? latest.current.pick?.from : undefined, at),
      startDrag: (at, shift) => {
        if (shift && latest.current.pick) finish(latest.current.pick.from, at);
        else setDrag({ from: at, to: at });
      },
      toggleNote: (key) =>
        setNotes((was) => {
          const next = new Set(was);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        }),
    }),
    [finish],
  );
  useEffect(() => {
    if (!drag) return;
    const onUp = () => {
      const d = latest.current.drag;
      setDrag(undefined);
      if (d) finish(d.to === d.from ? undefined : d.from, d.to);
    };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, [drag, finish]);
  const onMouseOver = (event: MouseEvent) => {
    if (!drag) return;
    const row = (event.target as Element).closest?.("[data-row]")?.getAttribute("data-row");
    if (!row) return;
    const [file, hunk, at] = row.split(":").map(Number) as [number, number, number];
    // Only along the hunk the drag started in; elsewhere the range keeps its last good end.
    if (file === drag.from.file && hunk === drag.from.hunk && at !== drag.to.row) {
      setDrag({ from: drag.from, to: { file, hunk, row: at } });
    }
  };

  const allCollapsed = collapsed.size === diff.files.length;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: moving the mouse only extends a drag the + buttons start.
    <div className="diff-view" ref={root} onMouseMove={onMouseOver}>
      <div className="diff-bar">
        <span className="mono small">
          {plural(diff.files.length, "file")} · <span className="add">+{totals.additions}</span>{" "}
          <span className="del">−{totals.deletions}</span>
        </span>
        {order.length > 0 && (
          <span className="faint small">
            {plural(order.length, "place")} to look · <kbd>]</kbd> next <kbd>[</kbd> previous
          </span>
        )}
        {onComment && (
          <span className="faint small">Click a line's + to comment; shift-click or drag for a range.</span>
        )}
        <button
          type="button"
          className="btn xs quiet diff-all"
          onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(diff.files.map((_, i) => i)))}
        >
          {allCollapsed ? "Expand all" : "Collapse all"}
        </button>
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">
        {said}
      </p>
      {notice && (
        <p className="diff-said faint small" role="status">
          {notice}
        </p>
      )}
      {diff.files.map((file, index) => (
        <DiffFileSection
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff lists each path once; the index keeps renames stable.
          key={`${index}:${file.path}`}
          file={file}
          index={index}
          collapsed={collapsed.has(index)}
          onToggle={toggle}
          markers={markers}
          selection={selection}
          highlight={highlight}
          notes={notes}
          commentable={onComment !== undefined}
          actions={actions}
          prUrl={props.prUrl}
          collapseOver={collapseOver}
        />
      ))}
    </div>
  );
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

export interface DiffPaneProps extends Omit<DiffViewProps, "diff"> {
  /** Fetches a diff: a PR's ("owner/repo#12"), or without one the local changes. */
  load: (pr?: string) => Promise<PrDiff>;
  /** The PR, "owner/repo#12"; absent for local changes. */
  pr?: string | undefined;
  /** The head commit the briefing was of: the diff is cached under it, and a newer head is pointed out. */
  headSha?: string | undefined;
}

/** The Diff tab: loads the diff (at once, if this PR's was loaded before) and shows it. */
export function DiffPane({ load, pr, headSha, ...view }: DiffPaneProps) {
  const [state, setState] = useState<{ diff?: PrDiff; error?: string }>({});
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` asks again after an error.
  useEffect(() => {
    let live = true;
    setState({});
    cachedDiff(load, pr, headSha).then(
      (diff) => live && setState({ diff }),
      (error) => live && setState({ error: messageOf(error) }),
    );
    return () => {
      live = false;
    };
  }, [load, pr, headSha, attempt]);

  if (state.error) {
    return (
      <StateCard
        tone="warn"
        glyph="!"
        title="The diff didn't load"
        body={state.error}
        action={
          <button type="button" className="btn primary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        }
      />
    );
  }
  if (!state.diff) return <StateCard tone="spin" title="Loading the diff…" live />;
  if (state.diff.files.length === 0) {
    return <StateCard tone="dashed" glyph="–" title="Nothing has changed" body="There's no diff to show." />;
  }
  return (
    <>
      {pr && headSha && state.diff.headSha !== headSha && (
        <p className="banner diff-newer" role="status">
          The PR has new commits since this briefing. This is its latest diff, so places may have moved. Brief again to
          catch up.
        </p>
      )}
      <DiffView key={state.diff.headSha} diff={state.diff} {...view} />
    </>
  );
}
