import type { Session } from "../api";
import { formatUsd } from "../format";
import { onLinkClick, type Route, routePath } from "../router";
import { Mark } from "./Mark";

const TABS: { label: string; route: Route; view: Route["view"] }[] = [
  { label: "Queue", route: { view: "queue" }, view: "queue" },
  { label: "My changes", route: { view: "local" }, view: "local" },
  { label: "Memory", route: { view: "memory" }, view: "memory" },
  { label: "Stats", route: { view: "stats" }, view: "stats" },
  { label: "Settings", route: { view: "settings" }, view: "settings" },
];

/** The mark, the views (with how many PRs wait), today's spend and who you're signed in as. */
export function TopBar({
  session,
  route,
  queueCount,
}: {
  session: Session | undefined;
  route: Route;
  queueCount?: number | undefined;
}) {
  const user = session?.user;
  const login = user && "login" in user ? user.login : undefined;
  return (
    <header className="topbar">
      <a className="brand" href="/" onClick={onLinkClick({ view: "queue" })} aria-label="Alden, your queue">
        <Mark />
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
            {tab.view === "queue" && queueCount !== undefined && <span className="count">{queueCount}</span>}
          </a>
        ))}
      </nav>
      {session && (
        <div className="topbar-meta">
          <span className="spend" title="Model spend today against your daily cap">
            today {formatUsd(session.budget.spentToday)} of {formatUsd(session.budget.dailyUsd)}
          </span>
          {login && (
            <span className="avatar" title={`Signed in as @${login}`}>
              {login.slice(0, 2)}
            </span>
          )}
          {user && "error" in user && (
            <span className="avatar problem" title={`GitHub sign-in problem: ${user.error}`}>
              !
            </span>
          )}
          {!user && (
            <span className="avatar problem" title="Not signed in to GitHub">
              ?
            </span>
          )}
        </div>
      )}
    </header>
  );
}
