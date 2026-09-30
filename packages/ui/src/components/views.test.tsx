// @vitest-environment jsdom
import type { Briefing, CheckResult, RankedPullRequest, RankedQueue } from "@alden/schema";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Session } from "../api";
import { BriefingView } from "./BriefingView";
import { QueueView } from "./QueueView";
import { effortSupported, initialChoices, toRequest } from "./ReviewOptions";

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
