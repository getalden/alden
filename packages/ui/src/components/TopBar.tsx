import type { Session } from "../api";
import { formatUsd } from "../format";
import { onLinkClick, type Route, routePath } from "../router";

const TABS: { label: string; route: Route }[] = [
  { label: "Queue", route: { view: "queue" } },
  { label: "My changes", route: { view: "local" } },
  { label: "Stats", route: { view: "stats" } },
  { label: "Settings", route: { view: "settings" } },
];

/** Who you are, which repo Alden runs in, and what the model will cost today. */
export function TopBar({ session, route }: { session: Session | undefined; route: Route }) {
  const user = session?.user;
  return (
    <header className="topbar">
      <a className="brand" href="/" onClick={onLinkClick({ view: "queue" })}>
        <span className="brand-mark" aria-hidden="true">
          A
        </span>
        Alden
      </a>
      <nav className="nav" aria-label="Views">
        {TABS.map((tab) => (
          <a
            key={tab.label}
            href={routePath(tab.route)}
            onClick={onLinkClick(tab.route)}
            aria-current={tab.route.view === route.view ? "page" : undefined}
          >
            {tab.label}
          </a>
        ))}
      </nav>
      {session && (
        <div className="topbar-meta">
          {session.repo?.repos[0] && (
            <span title={session.repo.root}>
              in <span className="mono">{session.repo.repos[0]}</span>
            </span>
          )}
          {session.model.available ? (
            <span className="badge accent" title={session.model.id}>
              {session.model.name}
              {session.model.effort ? ` · ${session.model.effort}` : ""}
            </span>
          ) : (
            <span className="badge" title={session.model.reason}>
              No model
            </span>
          )}
          <span title="Model spend today against your daily cap">
            {formatUsd(session.budget.spentToday)} of {formatUsd(session.budget.dailyUsd)} today
          </span>
          {user && "login" in user && <span>@{user.login}</span>}
          {user && "error" in user && (
            <span className="badge high" title={user.error}>
              GitHub sign-in problem
            </span>
          )}
          {!user && <span className="badge high">Not signed in</span>}
        </div>
      )}
    </header>
  );
}
