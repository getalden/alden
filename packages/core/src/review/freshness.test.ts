import type { BriefingTarget } from "@alden/schema";
import { describe, expect, it } from "vitest";
import type { GitHubClient } from "../github/client.js";
import { checkFreshness, fetchPullRequestNow, freshnessOf } from "./freshness.js";

const target = (extra: Partial<Extract<BriefingTarget, { kind: "pr" }>> = {}): BriefingTarget => ({
  kind: "pr",
  repo: "acme/app",
  number: 7,
  url: "https://github.com/acme/app/pull/7",
  title: "T",
  author: "sam",
  baseRef: "main",
  headRef: "feature",
  headSha: "h1",
  baseSha: "b1",
  graphFrom: "merge",
  ...extra,
});

describe("freshnessOf", () => {
  it("is fresh while the PR's head and its base are what the briefing saw", () => {
    expect(freshnessOf(target(), { headSha: "h1", baseRef: "main", baseSha: "b1" })).toEqual({ state: "fresh" });
  });

  it("says the PR changed, with how many new commits, before anything about the base", () => {
    expect(
      freshnessOf(target(), { headSha: "h3", baseRef: "main", baseSha: "b2", newCommits: 2, baseCommits: 4 }),
    ).toEqual({ state: "pr_changed", commits: 2 });
    // Force-pushed: the briefed head is gone from the PR, so there's no count.
    expect(freshnessOf(target(), { headSha: "h9", baseRef: "main", baseSha: "b1" })).toEqual({ state: "pr_changed" });
    // Retargeted to another base.
    expect(freshnessOf(target(), { headSha: "h1", baseRef: "release", baseSha: "r1" })).toEqual({
      state: "pr_changed",
    });
  });

  it("says the base moved when the graph came from the merge", () => {
    expect(freshnessOf(target(), { headSha: "h1", baseRef: "main", baseSha: "b2", baseCommits: 4 })).toEqual({
      state: "base_moved",
      baseRef: "main",
      commits: 4,
    });
  });

  it("ignores a moved base when callers came from the PR's branch, which never saw it", () => {
    const fromHead = target({ graphFrom: "head" });
    delete (fromHead as { baseSha?: string }).baseSha;
    expect(freshnessOf(fromHead, { headSha: "h1", baseRef: "main", baseSha: "b2", baseCommits: 4 })).toEqual({
      state: "fresh",
    });
  });

  it("can't tell for older briefings and local changes", () => {
    const old = target();
    delete (old as { headSha?: string }).headSha;
    expect(freshnessOf(old, { headSha: "h1", baseRef: "main" })).toMatchObject({ state: "unknown" });
    expect(freshnessOf({ kind: "local", repoRoot: "/r", branch: null }, { headSha: "", baseRef: "" })).toMatchObject({
      state: "unknown",
    });
  });
});

/** GitHub's answer for the PR now: its last commits (oldest first), and the base's tip and distance. */
function github(answer: { commits: string[]; base: string; behindBy?: number | null; compareFails?: boolean }) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    graphql: async (_query: string, variables: Record<string, unknown>) => {
      calls.push(variables);
      if (variables.compare && answer.compareFails) throw new Error("Could not resolve to a commit");
      return {
        repository: {
          pullRequest: {
            headRefOid: answer.commits.at(-1),
            baseRefName: "main",
            commits: { nodes: answer.commits.map((oid) => ({ commit: { oid } })) },
            baseRef: {
              target: { oid: answer.base },
              ...(variables.compare
                ? { compare: answer.behindBy === null ? null : { behindBy: answer.behindBy } }
                : {}),
            },
          },
        },
      };
    },
  } as unknown as GitHubClient;
  return { client, calls };
}

describe("fetchPullRequestNow", () => {
  it("counts new commits on the PR and on the base in one request", async () => {
    const { client, calls } = github({ commits: ["h0", "h1", "h2", "h3"], base: "b5", behindBy: 4 });
    expect(await fetchPullRequestNow(client, "acme/app", 7, { headSha: "h1", baseSha: "b1" })).toEqual({
      headSha: "h3",
      baseRef: "main",
      baseSha: "b5",
      newCommits: 2,
      baseCommits: 4,
    });
    expect(calls).toEqual([{ owner: "acme", name: "app", number: 7, since: "b1", compare: true }]);
  });

  it("asks again without the comparison when GitHub won't compare, e.g. the base commit is gone", async () => {
    const { client, calls } = github({ commits: ["h1"], base: "b5", compareFails: true });
    expect(await fetchPullRequestNow(client, "acme/app", 7, { headSha: "h1", baseSha: "b1" })).toEqual({
      headSha: "h1",
      baseRef: "main",
      baseSha: "b5",
      newCommits: 0,
    });
    expect(calls.map((c) => c.compare)).toEqual([true, false]);
  });
});

describe("checkFreshness", () => {
  it("compares the base only for a graph from the merge, and doesn't ask GitHub about older briefings", async () => {
    const moved = github({ commits: ["h1"], base: "b5", behindBy: 4 });
    expect(await checkFreshness(moved.client, target())).toEqual({ state: "base_moved", baseRef: "main", commits: 4 });

    const fromHead = github({ commits: ["h1"], base: "b5", behindBy: 4 });
    expect(await checkFreshness(fromHead.client, target({ graphFrom: "head" }))).toEqual({ state: "fresh" });
    expect(fromHead.calls[0]?.compare).toBe(false);

    const old = target();
    delete (old as { headSha?: string }).headSha;
    const none = github({ commits: ["h1"], base: "b5" });
    expect(await checkFreshness(none.client, old)).toMatchObject({ state: "unknown" });
    expect(none.calls).toEqual([]);
  });
});
