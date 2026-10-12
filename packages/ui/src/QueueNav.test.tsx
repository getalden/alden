// @vitest-environment jsdom
import type { RankedPullRequest, RankedQueue } from "@alden/schema";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import type { Api, Session } from "./api";
import { QueueView } from "./components/QueueView";
import { readQueueNav } from "./queue-prefs";

function row(repo: string, number: number, pr: Partial<RankedPullRequest["pr"]> = {}, lane = "needs-you") {
  return {
    pr: {
      repo,
      number,
      title: `PR ${number}`,
      url: `https://github.com/${repo}/pull/${number}`,
      author: "sam",
      authorIsBot: false,
      isDraft: false,
      createdAt: "2026-09-28T10:00:00Z",
      updatedAt: "2026-09-28T10:00:00Z",
      baseRef: "main",
      headRef: `feature-${number}`,
      additions: 10,
      deletions: 2,
      changedFiles: 1,
      files: [],
      filesTruncated: false,
      labels: [],
      assignees: [],
      ci: "success",
      mergeable: "mergeable",
      reviews: [],
      request: { direct: true, teams: [], requestedAt: null },
      codeownedFiles: [],
      stackedPrs: 0,
      ...pr,
    },
    lane,
    ...(lane === "fast-track" ? { fastTrack: "docs only" } : {}),
    score: { risk: 1, wait: 1, blocking: 0, total: 2 },
    reasons: [],
    waitingHours: 72,
    waitingOnAuthor: false,
  } as RankedPullRequest;
}

const queue: RankedQueue = {
  schemaVersion: 1,
  viewer: "me",
  fetchedAt: new Date().toISOString(),
  needsYou: [
    row("acme/api", 1, { title: "Charge in cents", additions: 300, labels: ["billing"] }),
    row("acme/web", 2, { author: "dependabot", authorIsBot: true, headRef: "dependabot/npm/zod", ci: "failure" }),
    row("acme/api", 3, { assignees: ["me"], request: { direct: false, teams: ["acme/core"], requestedAt: null } }),
  ],
  fastTrack: [row("acme/api", 4, { title: "Fix a docs typo", additions: 1 }, "fast-track")],
  warnings: [],
};

const prs = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-pr]")].map((r) => r.getAttribute("data-pr"));

beforeEach(() => {
  // jsdom doesn't lay anything out.
  Element.prototype.scrollIntoView = () => {};
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});
afterEach(cleanup);

describe("searching and filtering the queue", () => {
  it("searches title, repo, #number, author and branch, and counts what's shown", () => {
    const { container } = render(
      <QueueView queue={queue} error={undefined} loading={false} onRefresh={() => {}} selected={undefined} />,
    );
    const search = screen.getByRole("searchbox", { name: "Search the queue" });
    expect(search.getAttribute("placeholder")).toBe("Search 4 PRs");
    expect(screen.getByRole("status").textContent).toBe("Sorted by rank");
    fireEvent.change(search, { target: { value: "cents" } });
    expect(prs(container)).toEqual(["acme/api#1"]);
    expect(screen.getByRole("status").textContent).toBe("Sorted by rank · 1 of 4");
    fireEvent.change(search, { target: { value: "#3" } });
    expect(prs(container)).toEqual(["acme/api#3"]);
    fireEvent.change(search, { target: { value: "npm/zod" } });
    expect(prs(container)).toEqual(["acme/web#2"]);
    fireEvent.change(search, { target: { value: "nothing like this" } });
    expect(screen.getByText("No PRs match.")).toBeTruthy();
    // Esc clears the search and hands focus back to the list.
    fireEvent.keyDown(search, { key: "Escape" });
    expect((search as HTMLInputElement).value).toBe("");
    expect(prs(container)).toHaveLength(4);
    expect(document.activeElement?.closest("[data-pr]")?.getAttribute("data-pr")).toBe("acme/api#1");
    // Enter opens the first match.
    fireEvent.change(search, { target: { value: "typo" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(window.location.pathname).toBe("/pr/acme/api/4");
  });

  it("combines filters in the Filter popover, shows which are on, and clears them in one click", () => {
    const { container } = render(
      <QueueView queue={queue} error={undefined} loading={false} onRefresh={() => {}} selected={undefined} />,
    );
    const filter = screen.getByRole("button", { name: "Filter" });
    fireEvent.click(filter);
    expect(screen.getByRole("dialog", { name: "Filters" })).toBeTruthy();
    const author = screen.getByRole("combobox", { name: "Author" });
    fireEvent.change(author, { target: { value: "bots" } });
    expect(prs(container)).toEqual(["acme/web#2"]);
    expect(author.className).toContain("on");
    fireEvent.change(screen.getByRole("combobox", { name: "CI" }), { target: { value: "passing" } });
    expect(screen.getByText("No PRs match.")).toBeTruthy();
    fireEvent.change(author, { target: { value: "" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Review requested of" }), { target: { value: "acme/core" } });
    expect(prs(container)).toEqual(["acme/api#3"]);
    expect(screen.getByText("1 of 4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(prs(container)).toHaveLength(4);
    fireEvent.change(screen.getByRole("combobox", { name: "Assignee" }), { target: { value: "you" } });
    expect(prs(container)).toEqual(["acme/api#3"]);
    fireEvent.change(screen.getByRole("combobox", { name: "Label" }), { target: { value: "billing" } });
    expect(prs(container)).toEqual([]);
    // The button says how many are on; Esc closes the popover and the line under it can still clear them.
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Label" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull();
    expect(screen.getByRole("button", { name: "Filter, 2 on" })).toBe(document.activeElement);
    // Nothing matches, so the empty list offers it too.
    expect(screen.getAllByRole("button", { name: "Clear filters" })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0] as HTMLElement);
    expect(prs(container)).toHaveLength(4);
  });

  it("sorts inside each group, keeps Alden's rank on each row, and says so", () => {
    const { container } = render(
      <QueueView queue={queue} error={undefined} loading={false} onRefresh={() => {}} selected={undefined} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), { target: { value: "size" } });
    // Ranked for you by size, then Fast-track: the groups stay apart.
    expect(prs(container)).toEqual(["acme/web#2", "acme/api#3", "acme/api#1", "acme/api#4"]);
    expect(within(container.querySelector('[data-pr="acme/api#1"]') as HTMLElement).getByText("rank 1")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Sorted by size");
    expect(screen.getByText(/within each group/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset sort" }));
    expect(prs(container)).toEqual(["acme/api#1", "acme/web#2", "acme/api#3", "acme/api#4"]);
  });
});

const session = {
  version: "0.5.0",
  cwd: "/tmp",
  repo: null,
  user: { login: "me", source: "gh" },
  model: { provider: "anthropic", name: "none", id: "none", effort: null, supportsEffort: false, available: false },
  aliases: {},
  efforts: [],
  budget: { perReviewUsd: 0.5, dailyUsd: 5, spentToday: 0 },
} as unknown as Session;

/** Answers what the queue needs; anything else never answers, which the UI treats as still loading. */
const api = new Proxy(
  {},
  {
    get: (_, name) => {
      if (name === "session") return async () => session;
      if (name === "queue") return async () => queue;
      if (name === "clone") return async (repo: string) => ({ repo, path: null, how: null });
      return () => new Promise(() => {});
    },
  },
) as unknown as Api;

const key = (k: string) => act(() => void fireEvent.keyDown(document.body, { key: k }));

describe("the queue pane in the app", () => {
  it("collapses to a rail with [ and comes back from the rail, remembering it across reloads", async () => {
    const { container, unmount } = render(<App api={api} />);
    await waitFor(() => expect(prs(container)).toHaveLength(4));
    const side = container.querySelector("aside.side") as HTMLElement;
    key("[");
    expect(side.className).toContain("collapsed");
    expect(window.localStorage.getItem("alden.queue.collapsed")).toBe("1");
    unmount();

    const again = render(<App api={api} />);
    await waitFor(() => expect(prs(again.container)).toHaveLength(4));
    const rail = screen.getByRole("button", { name: "Show the queue, 4 PRs" });
    fireEvent.click(rail);
    expect((again.container.querySelector("aside.side") as HTMLElement).className).not.toContain("collapsed");
    fireEvent.click(screen.getByRole("button", { name: "Collapse the queue" }));
    expect((again.container.querySelector("aside.side") as HTMLElement).className).toContain("collapsed");
    key("[");
    expect((again.container.querySelector("aside.side") as HTMLElement).className).not.toContain("collapsed");
    expect(window.localStorage.getItem("alden.queue.collapsed")).toBeNull();
  });

  it("focuses the search with /, even from the rail, and j/k walk the filtered list", async () => {
    const { container } = render(<App api={api} />);
    await waitFor(() => expect(prs(container)).toHaveLength(4));
    key("[");
    key("/");
    const search = screen.getByRole("searchbox", { name: "Search the queue" });
    expect(container.querySelector("aside.side")?.className).not.toContain("collapsed");
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: "acme/api" } });
    await waitFor(() => expect(prs(container)).toEqual(["acme/api#1", "acme/api#3", "acme/api#4"]));
    fireEvent.keyDown(search, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Repository" }), { target: { value: "acme/api" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    key("j");
    expect(window.location.pathname).toBe("/pr/acme/api/1");
    key("j");
    expect(window.location.pathname).toBe("/pr/acme/api/3");
    key("k");
    expect(window.location.pathname).toBe("/pr/acme/api/1");
  });

  it("remembers filters and sort across reloads, and resets them in one click", async () => {
    const first = render(<App api={api} />);
    await waitFor(() => expect(prs(first.container)).toHaveLength(4));
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Author" }), { target: { value: "bots" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), { target: { value: "updated" } });
    expect(readQueueNav()).toEqual({ filters: { author: "bots" }, sort: "updated" });
    first.unmount();

    const { container } = render(<App api={api} />);
    await waitFor(() => expect(prs(container)).toEqual(["acme/web#2"]));
    expect(screen.getByRole("status").textContent).toBe("Sorted by last update · 1 of 4");
    fireEvent.click(screen.getByRole("button", { name: "Filter, 1 on" }));
    expect((screen.getByRole("combobox", { name: "Sort" }) as HTMLSelectElement).value).toBe("updated");
    fireEvent.click(screen.getByRole("button", { name: "Reset filters and sort" }));
    expect(prs(container)).toHaveLength(4);
    expect(window.localStorage.getItem("alden.queue.view")).toBeNull();
  });

  it("ignores a remembered view it can't read", async () => {
    window.localStorage.setItem("alden.queue.view", "{not json");
    const { container } = render(<App api={api} />);
    await waitFor(() => expect(prs(container)).toHaveLength(4));
  });
});

describe("Your turn in the app", () => {
  it("marks a PR's news seen when you open it, and drops it from Your turn once you move on", async () => {
    const turn = {
      pr: "acme/shop#12",
      repo: "acme/shop",
      number: 12,
      title: "Charge in cents",
      url: "https://github.com/acme/shop/pull/12",
      news: {
        text: "Ana replied to your comment",
        at: "2026-09-28T10:00:00Z",
        replies: 1,
        resolved: 0,
        outdated: 0,
        thread: "T1",
        events: ["e1"],
      },
    };
    const seen: string[] = [];
    const withTurn = new Proxy(
      {},
      {
        get: (_, name) => {
          if (name === "queue") return async () => ({ ...queue, yourTurn: [turn] });
          if (name === "followUpsSeen") {
            return async (pr: string) => {
              seen.push(pr);
              return { seen: 1 };
            };
          }
          return (api as unknown as Record<string | symbol, unknown>)[name];
        },
      },
    ) as unknown as Api;
    const { container } = render(<App api={withTurn} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Your turn 1" })).toBeTruthy());
    // Filters narrow the queue, not Your turn.
    expect(prs(container)).toEqual(["acme/shop#12", "acme/api#1", "acme/web#2", "acme/api#3", "acme/api#4"]);
    fireEvent.click(within(container.querySelector('[data-pr="acme/shop#12"]') as HTMLElement).getByRole("link"));
    expect(window.location.pathname).toBe("/pr/acme/shop/12");
    await waitFor(() => expect(seen).toEqual(["acme/shop#12"]));
    // Still there while it's open.
    expect(screen.getByRole("heading", { name: "Your turn 1" })).toBeTruthy();
    key("j");
    await waitFor(() => expect(screen.queryByRole("heading", { name: /^Your turn/ })).toBeNull());
    expect(seen).toEqual(["acme/shop#12"]);
  });
});
