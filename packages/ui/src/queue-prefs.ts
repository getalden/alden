import { DEFAULT_QUEUE_NAV, parseQueueNav, type QueueNav } from "@alden/schema/queue-nav";
import { useCallback, useState } from "react";

/**
 * The queue pane's remembered state: its filters and sort, and whether it's collapsed to a rail. Kept per browser (the
 * desktop app's window keeps its own), like the theme; storage that's blocked just means it lasts for this page.
 */
const NAV_KEY = "alden.queue.view";
const COLLAPSED_KEY = "alden.queue.collapsed";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | undefined): void {
  try {
    if (value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // storage blocked: the choice lasts for this page
  }
}

export function readQueueNav(): QueueNav {
  const raw = read(NAV_KEY);
  if (!raw) return DEFAULT_QUEUE_NAV;
  try {
    return parseQueueNav(JSON.parse(raw));
  } catch {
    return DEFAULT_QUEUE_NAV;
  }
}

const isDefault = (nav: QueueNav) => nav.sort === "rank" && Object.keys(nav.filters).length === 0;

/** Filters and sort, remembered across reloads. */
export function useQueueNav(): [QueueNav, (next: QueueNav | ((nav: QueueNav) => QueueNav)) => void] {
  const [nav, setNav] = useState(readQueueNav);
  const update = useCallback((next: QueueNav | ((nav: QueueNav) => QueueNav)) => {
    setNav((current) => {
      const value = typeof next === "function" ? next(current) : next;
      write(NAV_KEY, isDefault(value) ? undefined : JSON.stringify(value));
      return value;
    });
  }, []);
  return [nav, update];
}

/** Whether the queue is collapsed to a rail, remembered across reloads. */
export function useQueueCollapsed(): [boolean, (collapsed: boolean | ((was: boolean) => boolean)) => void] {
  const [collapsed, setCollapsed] = useState(() => read(COLLAPSED_KEY) === "1");
  const update = useCallback((next: boolean | ((was: boolean) => boolean)) => {
    setCollapsed((was) => {
      const value = typeof next === "function" ? next(was) : next;
      write(COLLAPSED_KEY, value ? "1" : undefined);
      return value;
    });
  }, []);
  return [collapsed, update];
}
