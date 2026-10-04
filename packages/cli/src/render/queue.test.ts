import type { PullRequestFacts, RankedPullRequest, RankedQueue } from "@alden/core";
import { describe, expect, it } from "vitest";
import { renderQueue, shouldColor } from "./queue.js";

function item(number: number, overrides: Partial<RankedPullRequest> = {}, pr: Partial<PullRequestFacts> = {}) {
  return {
    lane: "needs-you",
    score: { risk: 0, wait: 0, blocking: 0, total: 0 },
    reasons: [],
    waitingHours: 30,
    waitingOnAuthor: false,
    ...overrides,
    pr: {
      repo: "getalden/alden",
      number,
      title: `PR ${number}`,
      url: `https://github.com/getalden/alden/pull/${number}`,
      author: "sam",
      authorIsBot: false,
      isDraft: false,
      createdAt: "2026-09-27T12:00:00Z",
      updatedAt: "2026-09-27T12:00:00Z",
      baseRef: "main",
      headRef: "x",
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
      ...pr,
    },
  } satisfies RankedPullRequest;
}

function queue(needsYou: RankedPullRequest[], fastTrack: RankedPullRequest[] = [], warnings: string[] = []) {
  return {
    schemaVersion: 1,
    viewer: "me",
    fetchedAt: "2026-09-28T18:00:00Z",
    needsYou,
    fastTrack,
    warnings,
  } satisfies RankedQueue;
}

describe("renderQueue", () => {
  it("says so when nothing is waiting", () => {
    expect(renderQueue(queue([]), { width: 100, color: false })).toBe("Nothing is waiting on @me's review.\n");
    // An org hiding its PRs looks like an empty queue, so its warning still shows.
    expect(renderQueue(queue([], [], ["acme uses single sign-on"]), { width: 100, color: false })).toBe(
      "Nothing is waiting on @me's review.\n\nWarning: acme uses single sign-on\n",
    );
  });

  it("numbers rows across both groups and puts the reasons under each row", () => {
    const out = renderQueue(
      queue(
        [item(7, { reasons: ["labelled hotfix", "waiting 30h"] }), item(8, {}, { ci: "failure" })],
        [item(9, { lane: "fast-track", fastTrack: "docs only" })],
      ),
      { width: 100, color: false },
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("Needs you (2)");
    expect(lines[1]).toMatch(/^#\s+PR\s+Title\s+Author\s+Waiting\s+Size\s+CI$/);
    expect(lines[2]).toMatch(/^1\.\s+getalden\/alden#7\s+PR 7\s+@sam\s+30h\s+\+10\/-2\s+pass$/);
    expect(lines[3]?.trim()).toBe("labelled hotfix");
    expect(lines[4]).toMatch(/^2\. .*fail$/);
    expect(lines[5]?.trim()).toBe("nothing stands out");
    expect(out).toContain("Fast-track (1)");
    expect(out).toMatch(/3\.\s+getalden\/alden#9/);
    expect(out).toContain("docs only");
    expect(out).toContain("alden open <#>");
  });

  it("shortens long repo names but always keeps the PR number", () => {
    const out = renderQueue(queue([item(25, {}, { repo: "octocat/react-apollo-client-with-a-long-name" })]), {
      width: 120,
      color: false,
    });
    const row = out.split("\n")[2] ?? "";
    expect(row).toMatch(/octocat\/react-apollo-c\S*…#25 /);
  });

  it("fits long titles into the terminal width", () => {
    const out = renderQueue(queue([item(1, {}, { title: "x".repeat(300) })]), { width: 90, color: false });
    const row = out.split("\n")[2] ?? "";
    expect(row.length).toBeLessThanOrEqual(90);
    expect(row).toContain("…");
  });

  it("tags and dims drafts, and leaves draft out of the reasons", () => {
    const ready = item(1, { reasons: ["labelled hotfix"] });
    const draft = item(2, { reasons: ["labelled hotfix", "draft"] }, { isDraft: true, title: "Rework checkout" });
    const lines = renderQueue(queue([ready, draft]), { width: 100, color: false }).split("\n");
    expect(lines[2]).toMatch(/^1\.\s+getalden\/alden#1\s+PR 1\s+@sam/);
    expect(lines[4]).toMatch(/^2\.\s+getalden\/alden#2\s+\[Draft\] Rework checkout\s+@sam/);
    expect(lines[5]?.trim()).toBe("labelled hotfix");

    const colored = renderQueue(queue([ready, draft]), { width: 100, color: true }).split("\n");
    expect(colored[2]?.startsWith("\u001b[2m")).toBe(false);
    expect(colored[4]?.startsWith("\u001b[2m2.")).toBe(true);
  });

  it("shows warnings first, and only colours when asked", () => {
    const plain = renderQueue(queue([item(1)], [], ["Couldn't list your teams"]), { width: 100, color: false });
    expect(plain.startsWith("Warning: Couldn't list your teams\n")).toBe(true);
    expect(plain).not.toContain("\u001b[");
    expect(renderQueue(queue([item(1)]), { width: 100, color: true })).toContain("\u001b[");
  });
});

describe("shouldColor", () => {
  const tty = { isTTY: true } as NodeJS.WriteStream;
  const pipe = { isTTY: false } as NodeJS.WriteStream;

  it("colours terminals, not pipes, and respects NO_COLOR and FORCE_COLOR", () => {
    expect(shouldColor(tty, {})).toBe(true);
    expect(shouldColor(pipe, {})).toBe(false);
    expect(shouldColor(tty, { NO_COLOR: "1" })).toBe(false);
    expect(shouldColor(pipe, { FORCE_COLOR: "1" })).toBe(true);
    expect(shouldColor(tty, { TERM: "dumb" })).toBe(false);
  });
});
