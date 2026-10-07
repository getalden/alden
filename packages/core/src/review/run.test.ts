import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AldenConfigSchema } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseUnifiedDiff } from "../diff/parse.js";
import type { GitHubClient } from "../github/client.js";
import { PR, prRepo, REPO } from "../graph/__fixtures__/pr-repo.js";
import { reviewPullRequest } from "./run.js";

// The clone is the fixture's, wherever the test runs.
const clonePath = vi.hoisted(() => ({ current: "" }));
vi.mock("../graph/clones.js", () => ({ findClone: async () => ({ path: clonePath.current, how: "here" }) }));

const config = AldenConfigSchema.parse({});
let fixture: Awaited<ReturnType<typeof prRepo>>;
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "alden-run-home-"));
  process.env.ALDEN_HOME = home;
});

afterEach(async () => {
  delete process.env.ALDEN_HOME;
  await fixture.cleanup();
  await rm(home, { recursive: true, force: true });
});

/** GitHub as a review sees it: the PR (head, merge, mergeable) and its files, from the fixture's own diff. */
function github(options: { mergeable?: "MERGEABLE" | "CONFLICTING" } = {}): GitHubClient {
  const files = parseUnifiedDiff(fixture.diff).map((f) => ({
    filename: f.path,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: fixture.diff.slice(fixture.diff.indexOf("@@")),
  }));
  const raw = {
    number: PR,
    title: "Rank by time",
    url: `https://github.com/${REPO}/pull/${PR}`,
    isDraft: false,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    mergeable: options.mergeable ?? "MERGEABLE",
    baseRefName: "main",
    headRefName: "pr",
    isCrossRepository: false,
    repository: { nameWithOwner: REPO },
    author: { login: "sam" },
    labels: { nodes: [] },
    files: { nodes: [{ path: "src/rank.ts", additions: 1, deletions: 1 }], pageInfo: { hasNextPage: false } },
    reviewRequests: { nodes: [] },
    reviews: { nodes: [] },
    commits: { nodes: [] },
    timelineItems: { nodes: [] },
    body: "",
    headRefOid: fixture.head,
    potentialMergeCommit: options.mergeable === "CONFLICTING" || !fixture.merge ? null : { oid: fixture.merge },
  };
  return {
    graphql: async () => ({ repository: { pullRequest: raw } }),
    request: async (route: string) => {
      if (route === "GET /user") return { data: { login: "me" } };
      if (route === "GET /user/teams") return { data: [] };
      if (route.endsWith("/files")) return { data: files };
      throw Object.assign(new Error("Not Found"), { status: 404 });
    },
  } as unknown as GitHubClient;
}

const callersOf = (briefing: Awaited<ReturnType<typeof reviewPullRequest>>) =>
  briefing.checks.find((c) => c.id === "callers.outside");

describe("reviewing a PR against its merge with the latest base", { timeout: 30_000 }, () => {
  it("finds callers added on the base since the PR branched, and keeps the PR's own diff for what changed", async () => {
    fixture = await prRepo();
    clonePath.current = fixture.clone;
    const briefing = await reviewPullRequest(github(), REPO, PR, config);

    expect(briefing.target).toMatchObject({
      kind: "pr",
      baseRef: "main",
      headSha: fixture.head,
      baseSha: fixture.base,
      graphFrom: "merge",
    });
    const callers = callersOf(briefing);
    // rankQueue (line 5 of the PR's version) changed, not helper, which sits at line 5 of the merged file.
    expect(callers?.summary).toMatch(/^1 removed or re-signed public symbol still called from 2 places/);
    expect(callers?.evidence.map((e) => e.anchor)).toEqual([
      { path: "src/cli.ts", line: 2 },
      { path: "src/late.ts", line: 3 },
    ]);
  });

  it("says callers come from the PR's branch when it conflicts, and misses what the base added", async () => {
    fixture = await prRepo();
    clonePath.current = fixture.clone;
    const briefing = await reviewPullRequest(github({ mergeable: "CONFLICTING" }), REPO, PR, config);

    expect(briefing.target).toMatchObject({ headSha: fixture.head, graphFrom: "head" });
    expect(briefing.target).not.toHaveProperty("baseSha");
    const callers = callersOf(briefing);
    expect(callers?.evidence.map((e) => e.anchor)).toEqual([{ path: "src/cli.ts", line: 2 }]);
    expect(callers?.summary).toMatch(
      /Callers from the PR's branch: it conflicts with main, so changes merged since aren't included\.$/,
    );
  });

  it("records the head it briefed even without the code graph", async () => {
    fixture = await prRepo();
    const briefing = await reviewPullRequest(github(), REPO, PR, config, undefined, { enabled: false });
    expect(briefing.target).toMatchObject({ headSha: fixture.head });
    expect(briefing.target).not.toHaveProperty("graphFrom");
  });
});
