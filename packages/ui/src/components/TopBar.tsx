import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import type { Api, Session } from "../api";
import { formatUsd, plural } from "../format";
import { navigate, onLinkClick, type Route, routePath } from "../router";
import { Mark } from "./Mark";

const TABS: { label: string; route: Route; view: Route["view"] }[] = [
  { label: "Queue", route: { view: "queue" }, view: "queue" },
  { label: "My changes", route: { view: "local" }, view: "local" },
  { label: "Memory", route: { view: "memory" }, view: "memory" },
  { label: "Stats", route: { view: "stats" }, view: "stats" },
];

/** "JR" for jrivera, "AN" for ana: up to two letters of the login. */
export function initials(login: string): string {
  const parts = login.split(/[-_.]+/).filter(Boolean);
  const two = parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : login.slice(0, 2);
  return two.toUpperCase();
}

/**
 * The window's top bar (44px): the mark, the views, today's spend against the daily cap, and the avatar, whose menu
 * holds Settings, Export feedback and Sign out. In the desktop app the bar is the title bar: it leaves room for the
 * window's buttons and drags the window.
 */
export function TopBar({
  session,
  route,
  api,
  onSignedOut,
}: {
  session: Session | undefined;
  route: Route;
  /** For Export feedback and Sign out; without it the menu holds Settings only. */
  api?: Pick<Api, "exportFeedback" | "saveFeedback" | "signOut"> | undefined;
  /** After Sign out: the session to read again, so the queue offers to sign in. */
  onSignedOut?: (() => void) | undefined;
}) {
  const desktop = session?.desktop === true;
  return (
    <header className={`topbar${desktop ? " desktop" : ""}`} data-tauri-drag-region={desktop ? "" : undefined}>
      <a className="brand" href="/" onClick={onLinkClick({ view: "queue" })} aria-label="Alden, your queue">
        <Mark size={18} />
        alden
      </a>
      <nav className="nav" aria-label="Views">
        {TABS.map((tab) => (
          <a
            key={tab.label}
            href={routePath(tab.route)}
            onClick={onLinkClick(tab.route)}
            aria-current={tab.view === route.view ? "page" : undefined}
          >
            {tab.label}
          </a>
        ))}
      </nav>
      {session && (
        <div className="topbar-meta" data-tauri-drag-region={desktop ? "" : undefined}>
          <span className="spend" title="Model spend today against your daily cap">
            {formatUsd(session.budget.spentToday)} of {formatUsd(session.budget.dailyUsd)} today
          </span>
          <AccountMenu session={session} api={api} onSignedOut={onSignedOut} settings={route.view === "settings"} />
        </div>
      )}
    </header>
  );
}

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

/**
 * The avatar (your initials, or ! / ? when GitHub isn't answering for you) and its menu. The arrows move through it,
 * Esc closes it, focus leaving it closes it.
 */
function AccountMenu(props: {
  session: Session;
  api?: Pick<Api, "exportFeedback" | "saveFeedback" | "signOut"> | undefined;
  onSignedOut?: (() => void) | undefined;
  settings: boolean;
}) {
  const { session, api } = props;
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string }>();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const user = session.user;
  const login = user && "login" in user ? user.login : undefined;
  const problem = user && "error" in user ? user.error : undefined;

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [open]);
  useEffect(() => {
    if (note?.tone !== "ok") return;
    const timer = setTimeout(() => setNote(undefined), 5_000);
    return () => clearTimeout(timer);
  }, [note]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const exportFeedback = async () => {
    close();
    if (!api) return;
    try {
      // The desktop app's window can't download files, so the server writes the export to Downloads.
      if (session.desktop) {
        const saved = await api.saveFeedback();
        setNote({ tone: "ok", text: `Saved ${plural(saved.events, "event")} to ${saved.shown}.` });
        return;
      }
      const events = await api.exportFeedback();
      download(`alden-feedback-${new Date().toISOString().slice(0, 10)}.json`, events);
      setNote({ tone: "ok", text: `Saved ${plural(events.length, "event")}.` });
    } catch (error) {
      setNote({ tone: "error", text: `Couldn't export your feedback: ${messageOf(error)}` });
    }
  };

  const signOut = async () => {
    close();
    if (!api) return;
    try {
      const { remaining } = await api.signOut();
      setNote(
        remaining
          ? { tone: "ok", text: `Signed out of Alden. ${remaining} still signs you in.` }
          : { tone: "ok", text: "Signed out." },
      );
      props.onSignedOut?.();
    } catch (error) {
      setNote({ tone: "error", text: `Couldn't sign out: ${messageOf(error)}` });
    }
  };

  const onMenuKey = (event: ReactKeyboardEvent) => {
    // Keys in the menu stay in the menu: j, k and s mean other things on the page.
    if (event.key !== "Tab") event.nativeEvent.stopPropagation();
    const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => items[(i + items.length) % items.length]?.focus();
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(items.length - 1);
    else if (event.key === "Escape") close();
    else return;
    event.preventDefault();
  };

  const label = login
    ? `Signed in as @${login}`
    : problem
      ? `GitHub sign-in problem: ${problem}`
      : "Not signed in to GitHub";
  return (
    <div className="account" ref={wrapper}>
      {note && (
        <span className={`account-note${note.tone === "error" ? " error-text" : ""}`} role="status">
          {note.text}
        </span>
      )}
      <button
        ref={button}
        type="button"
        className={`avatar${login ? "" : " problem"}${props.settings ? " current" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "account-menu" : undefined}
        aria-label={`${label}. Account menu`}
        title={label}
        onClick={() => {
          if (open) return close();
          setNote(undefined);
          setOpen(true);
        }}
      >
        {login ? initials(login) : problem ? "!" : "?"}
      </button>
      {open && (
        <div
          ref={menu}
          id="account-menu"
          className="account-menu"
          role="menu"
          tabIndex={-1}
          aria-label="Account"
          onKeyDown={onMenuKey}
          onBlur={(event) => {
            if (!wrapper.current?.contains(event.relatedTarget as Node | null)) close(false);
          }}
          // Clicking an item mustn't move focus first: WebKit would close the menu before the click lands.
          onMouseDown={(event) => event.preventDefault()}
        >
          <div className="account-who">
            <span className="mono">{login ? `@${login}` : "Not signed in"}</span>
            {problem && <span className="faint small">{problem}</span>}
          </div>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              close(false);
              navigate({ view: "settings" });
            }}
          >
            Settings
          </button>
          {api && (
            <button type="button" role="menuitem" tabIndex={-1} onClick={exportFeedback}>
              Export feedback
              <span className="hint">{session.desktop ? "to Downloads" : ".json"}</span>
            </button>
          )}
          {api && login && (
            <button type="button" role="menuitem" tabIndex={-1} onClick={signOut}>
              Sign out
            </button>
          )}
        </div>
      )}
    </div>
  );
}
