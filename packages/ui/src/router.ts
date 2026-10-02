import { useEffect, useState } from "react";

/** Where the UI is: the queue (optionally with a PR open beside it), local changes, stats, memory or settings. */
export type Route =
  | { view: "queue"; pr?: { repo: string; number: number } }
  | { view: "local" }
  | { view: "stats" }
  | { view: "memory" }
  | { view: "settings" };

export function parseRoute(pathname: string): Route {
  const pr = /^\/pr\/([^/]+)\/([^/]+)\/(\d+)\/?$/.exec(pathname);
  if (pr) return { view: "queue", pr: { repo: `${pr[1]}/${pr[2]}`, number: Number(pr[3]) } };
  if (/^\/local\/?$/.test(pathname)) return { view: "local" };
  if (/^\/settings\/?$/.test(pathname)) return { view: "settings" };
  if (/^\/stats\/?$/.test(pathname)) return { view: "stats" };
  if (/^\/memory\/?$/.test(pathname)) return { view: "memory" };
  return { view: "queue" };
}

export function routePath(route: Route): string {
  if (route.view === "local") return "/local";
  if (route.view === "settings") return "/settings";
  if (route.view === "stats") return "/stats";
  if (route.view === "memory") return "/memory";
  return route.pr ? `/pr/${route.pr.repo}/${route.pr.number}` : "/";
}

export function navigate(route: Route): void {
  const path = routePath(route);
  if (path === window.location.pathname) return;
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return route;
}

/** A plain link that navigates inside the app, and still works with ⌘-click and middle-click. */
export function onLinkClick(route: Route) {
  return (event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; button: number; preventDefault(): void }) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(route);
  };
}
