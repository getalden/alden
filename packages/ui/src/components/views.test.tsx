// @vitest-environment jsdom
import type { Briefing, CheckResult, RankedPullRequest, RankedQueue } from "@alden/schema";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Session } from "../api";
import type { BriefingFeedback, Verdict } from "../feedback";
import { waitingSince } from "../format";
import { BriefingView, groupHidden } from "./BriefingView";
import { MemoryView } from "./MemoryView";
import { QueueView } from "./QueueView";
import { effortSupported, initialChoices, toRequest } from "./ReviewOptions";
import { formatHours, StatsView } from "./StatsView";
import { TelemetryCard } from "./TelemetryCard";

afterEach(cleanup);

function row(repo: string, number: number, overrides: Partial<RankedPullRequest> = {}): RankedPullRequest {
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
      headRef: "feature",
      additions: 10,
      deletions: 2,
      changedFiles: 1,
      files: [],
      filesTruncated: false,
      labels: [],
      ci: "success",
      mergeable: "mergeable",
      reviews: [],
      request: { direct: true, teams: [], requestedAt: null },
      codeownedFiles: [],
      stackedPrs: 0,
    },
    lane: "needs-you",
    score: { risk: 1, wait: 1, blocking: 0, total: 2 },
    reasons: ["waiting 3d", "touches migrations/"],
    waitingHours: 72,
    waitingOnAuthor: false,
    ...overrides,
  };
}

const queue: RankedQueue = {
  schemaVersion: 1,
  viewer: "you",
  fetchedAt: "2026-09-30T10:00:00Z",
  needsYou: [
    row("acme/api", 1),
    row("acme/web", 2, {
      waitingOnAuthor: true,
      reasons: ["CI failing: ping @sam"],
      pr: { ...row("acme/web", 2).pr, ci: "failure" },
    }),
  ],
  fastTrack: [row("acme/api", 3, { lane: "fast-track", fastTrack: "docs only", reasons: [] })],
  warnings: [],
};

const noop = () => {};

describe("QueueView", () => {
  it("shows both lanes, numbered in order, with reasons that aren't already on the row", () => {
    const { container } = render(
      <QueueView
        queue={{
          ...queue,
          needsYou: [
            row("acme/api", 1, {
              reasons: ["waiting 3d", "touches migrations/", "ranked higher: you usually open PRs touching db/ first"],
            }),
            ...queue.needsYou.slice(1),
          ],
        }}
        error={undefined}
        loading={false}
        onRefresh={noop}
        selected="acme/api#1"
      />,
    );
    const rows = [...container.querySelectorAll("[data-pr]")] as HTMLElement[];
    expect(rows.map((r) => r.getAttribute("data-pr"))).toEqual(["acme/api#1", "acme/web#2", "acme/api#3"]);
    expect(
      within(rows[0] as HTMLElement)
        .getByRole("link")
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(within(rows[0] as HTMLElement).getByText("01")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("touches migrations/")).toBeTruthy();
    // The wait has its own place, and a learned reason its own line, so neither is repeated as a chip.
    expect(within(rows[0] as HTMLElement).queryByText("waiting 3d")).toBeNull();
    expect(
      within(rows[0] as HTMLElement).getByText("ranked higher: you usually open PRs touching db/ first"),
    ).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("CI failing: ping @sam")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText(/docs only/)).toBeTruthy();
    expect(screen.getByText("Needs you · 2")).toBeTruthy();
  });

  it("takes Useful, Not useful and Dismiss on the selected row, and says what each does", () => {
    const reactions: string[] = [];
    const { rerender } = render(
      <QueueView
        queue={queue}
        error={undefined}
        loading={false}
        onRefresh={noop}
        selected="acme/api#1"
        onReact={(key, r) => reactions.push(`${key}:${r}`)}
      />,
    );
    // Only the selected row shows the buttons.
    expect(screen.getAllByRole("button", { name: "↑ Useful" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "× Dismiss" }));
    expect(reactions).toEqual(["acme/api#1:dismiss"]);
    rerender(
      <QueueView
        queue={{ ...queue, dismissed: [row("acme/old", 9)] }}
        error={undefined}
        loading={false}
        onRefresh={noop}
        selected="acme/api#1"
        reactions={{ "acme/api#1": "dismiss" }}
        onReact={(key, r) => reactions.push(`${key}:${r}`)}
      />,
    );
    expect(screen.getByText("Hidden until it changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "show" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(reactions.at(-1)).toBe("acme/old#9:dismiss");
  });

  it("says how close a reaction brought a lesson", () => {
    const note = "Dependabot PRs: 2 not useful so far. One more and Alden will rank them lower.";
    render(
      <QueueView
        queue={queue}
        error={undefined}
        loading={false}
        onRefresh={noop}
        selected="acme/api#1"
        reactions={{ "acme/api#1": "down" }}
        reactionNotes={{ "acme/api#1": note }}
        onReact={noop}
      />,
    );
    expect(screen.getByText(note)).toBeTruthy();
  });

  it("filters by repo", () => {
    const { container } = render(
      <QueueView
        queue={queue}
        error={undefined}
        loading={false}
        nav={{ filters: { repo: "acme/web" }, sort: "rank" }}
        onNav={noop}
        onRefresh={noop}
        selected={undefined}
      />,
    );
    expect(container.querySelectorAll("[data-pr]").length).toBe(1);
  });

  it("lists every repo in the queue for the filter, dismissed PRs' too", () => {
    render(
      <QueueView
        queue={{ ...queue, dismissed: [row("zeta/old", 9)] }}
        error={undefined}
        loading={false}
        onRefresh={noop}
        selected={undefined}
      />,
    );
    const options = within(screen.getByRole("combobox", { name: "Repository" })).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Repo", "acme/api", "acme/web", "zeta/old"]);
  });

  it("shows an old queue's age while the current one loads, and nothing for a fresh one", () => {
    const props = {
      error: undefined,
      onRefresh: noop,
      selected: undefined,
    };
    const { rerender } = render(
      <QueueView {...props} queue={queue} loading now={Date.parse(queue.fetchedAt) + 3 * 60_000} />,
    );
    expect(screen.getByText("As of 3 min ago, refreshing…")).toBeTruthy();
    rerender(<QueueView {...props} queue={queue} loading={false} now={Date.parse(queue.fetchedAt) + 2 * 3_600_000} />);
    expect(screen.getByText("As of 2h ago")).toBeTruthy();
    rerender(<QueueView {...props} queue={queue} loading={false} now={Date.parse(queue.fetchedAt) + 20_000} />);
    expect(screen.queryByText(/^As of/)).toBeNull();
  });

  it("gives one waiting time, saying what it counts from", () => {
    const asked = row("acme/api", 1, {
      waitingHours: 7.6,
      pr: { ...row("acme/api", 1).pr, request: { direct: true, teams: [], requestedAt: "2026-09-30T02:00:00Z" } },
    });
    render(
      <QueueView
        queue={{ ...queue, needsYou: [asked], fastTrack: [] }}
        error={undefined}
        loading={false}
        onRefresh={noop}
        selected={undefined}
      />,
    );
    expect(screen.getByTitle("Waiting 8h since you were asked").textContent).toBe("8h");
    expect(waitingSince(row("acme/api", 1))).toBe("3d since it opened");
  });

  it("says how to sign in instead of showing an error", () => {
    render(
      <QueueView
        queue={undefined}
        error="Not signed in"
        loading={false}
        onRefresh={noop}
        selected={undefined}
        signedOut
      />,
    );
    expect(screen.getByText("alden auth login")).toBeTruthy();
    expect(screen.queryByText("Not signed in")).toBeNull();
  });
});

const check = (id: string, status: CheckResult["status"], extra: Partial<CheckResult> = {}): CheckResult => ({
  id,
  title: id,
  status,
  severity: status === "flagged" ? "high" : "info",
  summary: `${id} summary`,
  evidence: [],
  heuristic: false,
  ...extra,
});

const briefing: Briefing = {
  schemaVersion: 1,
  target: {
    kind: "pr",
    repo: "acme/api",
    number: 1,
    url: "https://github.com/acme/api/pull/1",
    title: "Change the charge API",
    author: "sam",
    baseRef: "main",
    headRef: "feature",
  },
  generatedAt: "2026-09-30T10:00:00Z",
  summary: { files: 1, additions: 3, deletions: 1, reviewableAdditions: 3, reviewableDeletions: 1 },
  files: [
    {
      path: "src/charge.ts",
      status: "modified",
      kind: "code",
      additions: 3,
      deletions: 1,
      binary: false,
      patchMissing: false,
    },
  ],
  checks: [
    check("callers.outside", "flagged", {
      title: "Callers outside the diff",
      evidence: [{ text: "calls charge (signature changed)", anchor: { path: "src/api.ts", line: 9 } }],
    }),
    check("tests.missing", "passed", { title: "Code changed without tests" }),
  ],
  needsYourEyes: [
    {
      title: "Caller of changed code in src/api.ts",
      reason: "calls charge (signature changed).",
      anchor: { path: "src/api.ts", line: 9 },
      checkId: "callers.outside",
    },
  ],
  notChecked: ["Whether the change does what its title says"],
  llm: {
    status: "ok",
    model: "claude-sonnet-5",
    provider: "anthropic",
    effort: "medium",
    summary: "Adds a currency to charge().",
    findings: [],
    droppedFindings: 1,
    omittedFiles: [],
    redactedSecrets: 2,
    usd: 0.0412,
  },
};

describe("BriefingView", () => {
  it("shows where to look, the checks with flagged ones open, and the model's footer", async () => {
    const { container } = render(<BriefingView briefing={briefing} perReviewUsd={0.5} />);
    expect(screen.getByText("Adds a currency to charge().")).toBeTruthy();
    expect(screen.getByText("Caller of changed code in src/api.ts.")).toBeTruthy();
    // Flagged checks start open, passed ones closed; a click toggles.
    const rows = screen.getAllByRole("button", { expanded: true });
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Callers outside the diff")]);
    expect(screen.getByText("calls charge (signature changed)")).toBeTruthy();
    fireEvent.click(rows[0] as HTMLElement);
    expect(screen.queryByText("calls charge (signature changed)")).toBeNull();
    expect(screen.getByText("claude-sonnet-5")).toBeTruthy();
    expect(screen.getByText("effort medium")).toBeTruthy();
    expect(screen.getByText("$0.04 of $0.50")).toBeTruthy();
    expect(screen.getByText("2 secrets hidden before sending")).toBeTruthy();
    expect(container.textContent).toContain("✓ 1 passed");
    // Places link into the PR's diff at the line.
    fireEvent.click(rows[0] as HTMLElement);
    await waitFor(() => {
      const link = container.querySelector("a.place") as HTMLAnchorElement | null;
      expect(link?.href).toMatch(/^https:\/\/github\.com\/acme\/api\/pull\/1\/files#diff-[0-9a-f]{64}R9$/);
    });
  });

  it("says where a moved file came from", () => {
    const files = [
      { ...briefing.files[0], path: "src/lib/charge.ts", previousPath: "src/charge.ts", status: "renamed" as const },
    ];
    render(<BriefingView briefing={{ ...briefing, files: files as Briefing["files"] }} />);
    expect(screen.getByText("moved from src/charge.ts")).toBeTruthy();
  });

  it("labels a critical check in words and styles it apart from high", () => {
    const checks = [
      check("secrets.likely", "flagged", { title: "Likely secrets", severity: "critical" }),
      ...briefing.checks,
    ];
    const { container } = render(<BriefingView briefing={{ ...briefing, checks }} />);
    expect(container.querySelector(".sev.critical")?.textContent).toBe("critical");
    expect(container.querySelector(".sev.high")?.textContent).toBe("high");
  });

  it("says so plainly when nothing needs a look", () => {
    render(<BriefingView briefing={{ ...briefing, needsYourEyes: [] }} />);
    expect(
      screen.getByText("Nothing flagged. Neither the checks nor the model found anything that needs a closer look."),
    ).toBeTruthy();
  });
});

describe("what learning changed in a briefing", () => {
  it("says why a place was picked, groups what was hidden by reason, and counts notes the model saw", () => {
    const learned: Briefing = {
      ...briefing,
      needsYourEyes: [
        {
          ...(briefing.needsYourEyes[0] as Briefing["needsYourEyes"][0]),
          learned: "You usually mark API change flags useful (4 of 4)",
        },
      ],
      learning: {
        hidden: [
          { title: "Untested change in a.ts", reason: "You usually mark untested-change flags not useful (3 of 3)" },
          { title: "Untested change in b.ts", reason: "You usually mark untested-change flags not useful (3 of 3)" },
          { title: "Config change in .env", reason: "You dismissed it on 2026-09-27" },
        ],
        memory: 2,
      },
    };
    const { container } = render(<BriefingView briefing={learned} />);
    expect(screen.getByText(/↑ You usually mark API change flags useful/)).toBeTruthy();
    const shaped = container.querySelector(".shaped")?.textContent ?? "";
    expect(shaped).toContain("Shaped by your feedback.");
    expect(shaped).toContain("#1 is here because you usually mark API change flags useful (4 of 4).");
    expect(shaped).toContain("2 places are hidden: you usually mark untested-change flags not useful (3 of 3).");
    expect(shaped).toContain("1 place is hidden: you dismissed it on 2026-09-27.");
    expect(shaped).toContain("The model had 2 of your notes for this repo.");
    fireEvent.click(screen.getByRole("button", { name: /3 hidden by your feedback/ }));
    expect(screen.getByText("Config change in .env")).toBeTruthy();
    expect(groupHidden(learned.learning?.hidden ?? []).map((g) => g.items.length)).toEqual([2, 1]);
  });

  it("marks a check row quietened by your feedback, with why", () => {
    const flagged = briefing.checks.find((c) => c.status === "flagged") as Briefing["checks"][0];
    const reason = "quietened by your feedback: you usually mark API change flags not useful (3 of 3)";
    render(
      <BriefingView
        briefing={{ ...briefing, learning: { hidden: [], quietened: [{ checkId: flagged.id, reason }], memory: 0 } }}
      />,
    );
    expect(
      screen.getByTitle("Quietened by your feedback: you usually mark API change flags not useful (3 of 3)"),
    ).toBeTruthy();
    expect(screen.getByText(/↓ Quietened by your feedback: you usually mark API change flags not useful/)).toBeTruthy();
  });
});

describe("MemoryView", () => {
  it("groups what you look for and skip, adds, edits, forgets and undoes, and pauses learning", async () => {
    const item = (id: string, source: "you" | "learned", group: "look" | "skip", text: string) => ({
      id,
      repo: "acme/api",
      source,
      kind: source === "you" ? ("note" as const) : ("check" as const),
      group,
      text,
      ...(source === "learned"
        ? { evidence: "you marked 3 of 3 useful", examples: 3, effect: "Picked first among the places to look." }
        : { effect: "Given to the model with every review of this repo." }),
      since: "2026-09-20T10:00:00.000Z",
    });
    let items = [
      item("note:1", "you", "look", "Cents, not floats"),
      item("check:x:up", "learned", "look", "You care about migration flags"),
      item("check:y:down", "learned", "skip", "You usually find untested-change flags not useful"),
    ];
    let paused = false;
    const calls: string[] = [];
    const memory = () => ({ repo: "acme/api", items, paused, path: "/home/.alden/alden.db" });
    const api = {
      memoryRepos: async () => [
        { repo: "acme/api", items: items.length, lastChange: new Date().toISOString(), paused },
      ],
      memory: async () => memory(),
      addMemory: async (text: string) => {
        calls.push(`add ${text}`);
        items = [...items, item("note:2", "you", "look", text)];
        return memory();
      },
      forgetMemory: async (id: string) => {
        calls.push(`forget ${id}`);
        items = items.filter((i) => i.id !== id);
        return memory();
      },
      changeMemory: async (change: { action: string; id?: string; text?: string; on?: boolean }) => {
        calls.push(`${change.action} ${change.id ?? change.on ?? ""}`.trim());
        if (change.action === "learning") paused = !change.on;
        if (change.action === "edit")
          items = items.map((i) => (i.id === change.id ? { ...i, text: change.text as string } : i));
        if (change.action === "restore")
          items = [...items, item("check:x:up", "learned", "look", "You care about migration flags")];
        return memory();
      },
    } as unknown as import("../api").Api;
    render(<MemoryView api={api} session={{ repo: { root: "/r", repos: ["acme/api"] } } as unknown as Session} />);
    expect(await screen.findByText("Cents, not floats")).toBeTruthy();
    expect(screen.getByText("What you look for")).toBeTruthy();
    expect(screen.getByText("What you skip")).toBeTruthy();
    expect(screen.getAllByText(/you marked 3 of 3 useful · since/)).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("New note"), { target: { value: "Check auth on new routes" } });
    fireEvent.click(screen.getByRole("button", { name: "Remember" }));
    expect(await screen.findByText("Check auth on new routes")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0] as HTMLElement);
    fireEvent.change(screen.getByLabelText("Edit note"), { target: { value: "Money is in cents" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Money is in cents")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Forget: You care about migration flags" }));
    expect(await screen.findByText("Forgotten. Alden stops using this from the next briefing.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo forgetting: You care about migration flags" }));
    await waitFor(() =>
      expect(screen.queryByText("Forgotten. Alden stops using this from the next briefing.")).toBeNull(),
    );

    fireEvent.click(screen.getByRole("switch", { name: "Learning from your reactions" }));
    expect(await screen.findByRole("switch", { name: "Learning paused" })).toBeTruthy();
    expect(calls).toEqual([
      "add Check auth on new routes",
      "edit note:1",
      "forget check:x:up",
      "restore check:x:up",
      "learning false",
    ]);
  });
});

describe("where a learned item came from", () => {
  it("lists the newest few sources, then how many more", async () => {
    const sources = [
      { from: "reactions" as const, weight: 3, at: "2026-10-01T12:00:00.000Z" },
      { from: "review" as const, pr: "acme/api#412", weight: 2, at: "2026-10-08T12:00:00.000Z" },
      { from: "outcome" as const, pr: "acme/api#390", weight: 1, at: "2026-10-05T12:00:00.000Z" },
      { from: "opens" as const, weight: 1, at: "2026-09-02T12:00:00.000Z" },
      { from: "review" as const, pr: "acme/api#380", weight: 1, at: "2026-09-01T12:00:00.000Z" },
    ];
    const item = (id: string, text: string, extra = {}) => ({
      id,
      repo: "acme/api",
      source: "learned" as const,
      kind: "check" as const,
      group: "look" as const,
      text,
      evidence: "you marked 3 of 3 useful",
      since: "2026-09-20T10:00:00.000Z",
      ...extra,
    });
    const memory = {
      repo: "acme/api",
      items: [item("check:x:up", "You care about callers flags", { sources }), item("check:y:up", "Older lesson")],
      paused: false,
      path: "/home/.alden/alden.db",
    };
    const api = {
      memoryRepos: async () => [{ repo: "acme/api", items: 2, lastChange: "", paused: false }],
      memory: async () => memory,
    } as unknown as import("../api").Api;
    render(<MemoryView api={api} session={{ repo: { root: "/r", repos: ["acme/api"] } } as unknown as Session} />);
    const list = await screen.findByRole("list", { name: "Where it came from" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "from your review of acme/api#412, Oct 8",
      "from how it went with acme/api#390, Oct 5",
      "from your reactions, Oct 1",
      "and 2 more",
    ]);
    // An item without sources (from an engine that doesn't say) shows none.
    expect(screen.getAllByRole("list", { name: "Where it came from" })).toHaveLength(1);
  });
});

describe("feedback in a briefing", () => {
  it("records useful, not useful and dismiss, takes a verdict back when pressed again, and reports misses", async () => {
    const verdicts = new Map<string, Verdict>();
    const calls: string[] = [];
    const feedback: BriefingFeedback = {
      verdictOf: (item) => verdicts.get(item.title),
      progressOf: (item) =>
        item.placement === "check" && verdicts.get(item.title) === "not_needed"
          ? "2 of 3: one more not useful on API change flags and Alden will quieten them."
          : undefined,
      toggle(item, verdict) {
        calls.push(`${item.placement}:${item.checkId}:${verdict}`);
        if (verdicts.get(item.title) === verdict) verdicts.delete(item.title);
        else verdicts.set(item.title, verdict);
      },
      reportMissed: async (note, anchor) => {
        calls.push(`missed:${note}:${anchor?.path}:${anchor?.line}`);
      },
      missedCount: 0,
      error: undefined,
    };
    const { rerender } = render(<BriefingView briefing={briefing} feedback={feedback} />);
    fireEvent.click(screen.getByRole("button", { name: "Useful" }));
    rerender(<BriefingView briefing={briefing} feedback={feedback} />);
    expect(screen.getByRole("button", { name: "✓ Useful" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Noted. Alden will look for more like this.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "✓ Useful" }));
    fireEvent.click(screen.getByRole("button", { name: "× Dismiss" }));
    // A flagged check takes its own verdict ("worth flagging?").
    fireEvent.click(screen.getByRole("button", { name: "↓ Not useful" }));
    rerender(<BriefingView briefing={briefing} feedback={feedback} />);
    // Each reaction says how close it brought a lesson.
    expect(
      screen.getByText("2 of 3: one more not useful on API change flags and Alden will quieten them."),
    ).toBeTruthy();
    expect(calls).toEqual([
      "eyes:callers.outside:agree",
      "eyes:callers.outside:agree",
      "eyes:callers.outside:dismiss",
      "check:callers.outside:not_needed",
    ]);

    fireEvent.change(screen.getByLabelText("What should it have flagged?"), { target: { value: "The retry loop" } });
    fireEvent.change(screen.getByLabelText("File and line (optional)"), { target: { value: "src/charge.ts:12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.at(-1)).toBe("missed:The retry loop:src/charge.ts:12"));
  });
});

describe("review options", () => {
  const session = {
    model: { provider: "anthropic", name: "sonnet", id: "claude-sonnet-5", effort: "medium", available: true },
    aliases: { sonnet: "claude-sonnet-5", haiku: "claude-haiku-4-5" },
  } as unknown as Session;

  it("sends only what differs from the config, and no effort to models that don't take it", () => {
    const choices = initialChoices(session);
    expect(toRequest(choices, session)).toEqual({ llm: true, graph: true, effort: "medium" });
    expect(toRequest({ ...choices, model: "haiku" }, session)).toEqual({ llm: true, graph: true, model: "haiku" });
    expect(toRequest({ ...choices, llm: false }, session)).toEqual({ llm: false, graph: true });
    expect(effortSupported(session, "haiku")).toBe(false);
  });
});

describe("StatsView", () => {
  const dist = (count: number, medianHours: number | null, p90Hours: number | null) => ({
    count,
    medianHours,
    p90Hours,
  });
  const stats = {
    schemaVersion: 1,
    repo: "acme/api",
    fetchedAt: "2026-09-30T10:00:00.000Z",
    window: { from: "2026-07-02T10:00:00.000Z", to: "2026-09-30T10:00:00.000Z" },
    split: { at: "2026-09-01T00:00:00.000Z", source: "first-use" },
    prs: 40,
    horizonHours: 336,
    timeToFirstReview: { all: dist(30, 20, 336), before: dist(20, 30, 336), after: dist(10, 12, 100) },
    cycleTime: { all: dist(28, 60, 336), before: dist(19, 50, 336), after: dist(9, 110, 336) },
    weeks: [
      { week: "2026-08-24", prs: 5, timeToFirstReviewMedianHours: 336, cycleTimeMedianHours: 336 },
      { week: "2026-09-07", prs: 6, timeToFirstReviewMedianHours: 10, cycleTimeMedianHours: 40 },
    ],
    excluded: { bots: 3, drafts: 1, tooRecent: 6, noReview: 2, noApproval: 4 },
    stillWaiting: { review: 1, approval: 2 },
    truncated: false,
  };
  const session = { repo: { root: "/r", repos: ["acme/api"] } } as unknown as Session;

  it("shows after-split medians with the change in words, and a labelled column per week", async () => {
    const api = { stats: async () => stats } as unknown as import("../api").Api;
    render(<StatsView api={api} session={session} />);
    expect(await screen.findByText("12h")).toBeTruthy();
    expect(screen.getByText(/60% faster/)).toBeTruthy();
    expect(screen.getByText(/2.2× slower/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Week of 24 Aug: 14d+ median, 5 PRs" })).toBeTruthy();
    expect(screen.getByText("Alden from 1 Sep")).toBeTruthy();
  });

  it("formats waits with the horizon as a floor", () => {
    expect([0.5, 30, 60, 336].map((h) => formatHours(h, 336))).toEqual(["30m", "30h", "2d 12h", "14d+"]);
  });
});

describe("TelemetryCard", () => {
  it("asks once, saves the answer, and stays away once answered or blocked", async () => {
    const answers: boolean[] = [];
    let consent: "on" | "off" | "unset" = "unset";
    const api = {
      telemetry: async () => ({ consent, blocked: null }),
      setTelemetry: async (on: boolean) => {
        answers.push(on);
        consent = on ? "on" : "off";
        return { consent, blocked: null };
      },
    } as unknown as import("../api").Api;
    const { unmount } = render(<TelemetryCard api={api} />);
    expect(await screen.findByText("Help shape Alden?")).toBeTruthy();
    expect(screen.getByText(/Never code, diffs, titles, paths, repo or user names/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send anonymous stats" }));
    await waitFor(() => expect(screen.queryByText("Help shape Alden?")).toBeNull());
    expect(answers).toEqual([true]);
    unmount();

    const blocked = {
      telemetry: async () => ({ consent: "unset", blocked: "DO_NOT_TRACK is set" }),
    } as unknown as import("../api").Api;
    render(<TelemetryCard api={blocked} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText("Help shape Alden?")).toBeNull();
  });
});
