// @vitest-environment jsdom
import type { Briefing, CheckResult, RankedPullRequest, RankedQueue } from "@alden/schema";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Session } from "../api";
import type { BriefingFeedback, Verdict } from "../feedback";
import { BriefingView, groupHidden } from "./BriefingView";
import { MemoryView } from "./MemoryView";
import { QueueView } from "./QueueView";
import { effortSupported, initialChoices, toRequest } from "./ReviewOptions";
import { formatHours, StatsView } from "./StatsView";

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
    render(
      <QueueView
        queue={queue}
        error={undefined}
        loading={false}
        repoFilter=""
        onRepoFilter={noop}
        onRefresh={noop}
        selected="acme/api#1"
      />,
    );
    const rows = screen.getAllByRole("link").filter((a) => a.getAttribute("data-pr"));
    expect(rows.map((r) => r.getAttribute("data-pr"))).toEqual(["acme/api#1", "acme/web#2", "acme/api#3"]);
    expect(rows[0]?.getAttribute("aria-current")).toBe("true");
    expect(within(rows[0] as HTMLElement).getByText("touches migrations/")).toBeTruthy();
    // The wait and the failing CI have their own places, so their reasons aren't repeated as chips.
    expect(within(rows[0] as HTMLElement).queryByText("waiting 3d")).toBeNull();
    expect(within(rows[1] as HTMLElement).getByText("Ping @sam")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryByText("CI failing: ping @sam")).toBeNull();
    expect(within(rows[2] as HTMLElement).getByText("docs only")).toBeTruthy();
  });

  it("filters by repo", () => {
    render(
      <QueueView
        queue={queue}
        error={undefined}
        loading={false}
        repoFilter="acme/web"
        onRepoFilter={noop}
        onRefresh={noop}
        selected={undefined}
      />,
    );
    expect(screen.getAllByRole("link").filter((a) => a.getAttribute("data-pr")).length).toBe(1);
  });

  it("says how to sign in instead of showing an error", () => {
    render(
      <QueueView
        queue={undefined}
        error="Not signed in"
        loading={false}
        repoFilter=""
        onRepoFilter={noop}
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
    const { container } = render(<BriefingView briefing={briefing} />);
    expect(screen.getByText("Adds a currency to charge().")).toBeTruthy();
    expect(screen.getByText("Caller of changed code in src/api.ts")).toBeTruthy();
    const details = [...container.querySelectorAll("details.check")] as HTMLDetailsElement[];
    expect(details.map((d) => d.open)).toEqual([true]);
    expect(screen.getByText(/claude-sonnet-5 via anthropic · effort medium · \$0\.04 ·/)).toBeTruthy();
    expect(screen.getByText(/2 likely secrets hidden from the model/)).toBeTruthy();
    // Places link into the PR's diff at the line.
    await waitFor(() => {
      const link = container.querySelector("a.place") as HTMLAnchorElement | null;
      expect(link?.href).toMatch(/^https:\/\/github\.com\/acme\/api\/pull\/1\/files#diff-[0-9a-f]{64}R9$/);
    });
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
          learned: "You usually agree with flags about callers outside the diff (4 of 4)",
        },
      ],
      learning: {
        hidden: [
          { title: "Untested change in a.ts", reason: "You usually mark untested-change flags not needed (3 of 3)" },
          { title: "Untested change in b.ts", reason: "You usually mark untested-change flags not needed (3 of 3)" },
          { title: "Config change in .env", reason: "You marked it not needed on 2026-09-27" },
        ],
        memory: 2,
      },
    };
    render(<BriefingView briefing={learned} />);
    expect(screen.getByText(/↑ You usually agree with flags about callers/)).toBeTruthy();
    expect(
      screen.getByText("Hidden 2 places. You usually mark untested-change flags not needed (3 of 3)."),
    ).toBeTruthy();
    expect(screen.getByText(/Hidden: Config change in \.env\. You marked it not needed on 2026-09-27\./)).toBeTruthy();
    expect(screen.getByText(/The model was given 2 notes on what you care about here/)).toBeTruthy();
    expect(groupHidden(learned.learning?.hidden ?? []).map((g) => g.items.length)).toEqual([2, 1]);
  });
});

describe("MemoryView", () => {
  it("lists notes and learned items, adds a note and forgets an item", async () => {
    const item = (id: string, source: "you" | "learned", text: string) => ({
      id,
      repo: "acme/api",
      source,
      kind: source === "you" ? ("note" as const) : ("check" as const),
      text,
      ...(source === "learned" ? { evidence: "agreed 3 of 3 times", effect: "picked first among places to look" } : {}),
      since: "2026-09-20T10:00:00.000Z",
    });
    let items = [
      item("note:1", "you", "Cents, not floats"),
      item("check:x:up", "learned", "You care about migration flags"),
    ];
    const calls: string[] = [];
    const api = {
      memory: async () => ({ repo: "acme/api", items }),
      addMemory: async (text: string) => {
        calls.push(`add ${text}`);
        items = [...items, item("note:2", "you", text)];
        return { repo: "acme/api", items };
      },
      forgetMemory: async (id: string) => {
        calls.push(`forget ${id}`);
        items = items.filter((i) => i.id !== id);
        return { repo: "acme/api", items };
      },
    } as unknown as import("../api").Api;
    render(<MemoryView api={api} session={{ repo: { root: "/r", repos: ["acme/api"] } } as unknown as Session} />);
    expect(await screen.findByText("Cents, not floats")).toBeTruthy();
    expect(screen.getByText(/agreed 3 of 3 times · picked first among places to look · since 2026-09-20/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("New note"), { target: { value: "Check auth on new routes" } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(await screen.findByText("Check auth on new routes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Forget: You care about migration flags" }));
    await waitFor(() => expect(screen.queryByText("You care about migration flags")).toBeNull());
    expect(calls).toEqual(["add Check auth on new routes", "forget check:x:up"]);
  });
});

describe("feedback in a briefing", () => {
  it("records agree and not needed on flags, taking a verdict back when pressed again, and reports misses", async () => {
    const verdicts = new Map<string, Verdict>();
    const calls: string[] = [];
    const feedback: BriefingFeedback = {
      verdictOf: (item) => verdicts.get(item.title),
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
    fireEvent.click(screen.getByRole("button", { name: "Agree" }));
    rerender(<BriefingView briefing={briefing} feedback={feedback} />);
    expect(screen.getByRole("button", { name: "Agree" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Agree" }));
    expect(calls).toEqual(["eyes:callers.outside:agree", "eyes:callers.outside:agree"]);

    fireEvent.change(screen.getByLabelText("What should Alden have flagged?"), { target: { value: "The retry loop" } });
    fireEvent.change(screen.getByLabelText("File (optional)"), { target: { value: "src/charge.ts" } });
    fireEvent.change(screen.getByLabelText("Line"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Report it" }));
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
