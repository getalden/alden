import type { BriefingFreshness, BriefingTarget } from "@alden/schema";
import type { GitHubClient } from "../github/client.js";

/** A PR as it is now on GitHub, against what a briefing recorded. */
export interface PullRequestNow {
  headSha: string;
  baseRef: string;
  /** The base branch's tip. Absent when the branch is gone. */
  baseSha?: string;
  /** Commits on the PR after the briefed head; absent when the briefed head isn't among its recent commits. */
  newCommits?: number;
  /** Commits on the base branch after the briefed base; absent when GitHub couldn't compare them. */
  baseCommits?: number;
}

/**
 * Whether a briefing (by its `target`) still matches the PR. A new push comes first (the whole briefing is out of date); then, for a
 * code graph built from the merge, a base branch that has moved since (callers may have been added or moved there).
 * A graph from the PR's branch didn't see the base, so a moved base doesn't make it stale.
 */
export function freshnessOf(target: BriefingTarget, now: PullRequestNow): BriefingFreshness {
  if (target.kind !== "pr") return { state: "unknown", reason: "Only PR briefings are compared with GitHub." };
  if (!target.headSha) return { state: "unknown", reason: "This briefing doesn't record which commit it saw." };
  if (now.headSha !== target.headSha || now.baseRef !== target.baseRef) {
    return { state: "pr_changed", ...(now.newCommits ? { commits: now.newCommits } : {}) };
  }
  if (target.graphFrom === "merge" && target.baseSha && now.baseSha && now.baseSha !== target.baseSha) {
    return { state: "base_moved", baseRef: now.baseRef, ...(now.baseCommits ? { commits: now.baseCommits } : {}) };
  }
  return { state: "fresh" };
}

/** How far back a PR's commits are searched for the briefed head. */
const RECENT_COMMITS = 100;

interface NowResponse {
  repository: {
    pullRequest: {
      headRefOid: string;
      baseRefName: string;
      commits: { nodes: { commit: { oid: string } }[] };
      baseRef: { target: { oid: string } | null; compare?: { behindBy: number } | null } | null;
    } | null;
  } | null;
}

/**
 * The PR's head and base now, counted against the commits a briefing saw: one GraphQL request. The base's count comes
 * from comparing the briefed base commit with the branch's tip; if GitHub won't compare them (the commit is gone), the
 * request is made again without it.
 */
export async function fetchPullRequestNow(
  client: GitHubClient,
  repo: string,
  number: number,
  seen: { headSha?: string | undefined; baseSha?: string | undefined } = {},
): Promise<PullRequestNow> {
  const [owner, name] = repo.split("/");
  const ask = (compare: boolean) =>
    client.graphql<NowResponse>(
      `query($owner: String!, $name: String!, $number: Int!, $since: String!, $compare: Boolean!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            headRefOid
            baseRefName
            commits(last: ${RECENT_COMMITS}) { nodes { commit { oid } } }
            baseRef { target { oid } compare(headRef: $since) @include(if: $compare) { behindBy } }
          }
        }
      }`,
      { owner, name, number, since: seen.baseSha ?? "", compare },
    );
  let data: NowResponse;
  try {
    data = await ask(seen.baseSha !== undefined);
  } catch (error) {
    if (seen.baseSha === undefined) throw error;
    data = await ask(false);
  }
  const pr = data.repository?.pullRequest;
  if (!pr) throw new Error(`Couldn't find ${repo}#${number}.`);
  const oids = pr.commits.nodes.map((n) => n.commit.oid);
  const at = seen.headSha ? oids.lastIndexOf(seen.headSha) : -1;
  const baseSha = pr.baseRef?.target?.oid;
  const behind = pr.baseRef?.compare?.behindBy;
  return {
    headSha: pr.headRefOid,
    baseRef: pr.baseRefName,
    ...(baseSha ? { baseSha } : {}),
    ...(at >= 0 ? { newCommits: oids.length - 1 - at } : {}),
    ...(behind !== undefined ? { baseCommits: behind } : {}),
  };
}

/**
 * Whether a PR briefing (by its `target`) still matches the PR on GitHub, with one request. Briefings of local changes,
 * and older ones that don't record their commits, are `unknown` without asking.
 */
export async function checkFreshness(client: GitHubClient, target: BriefingTarget): Promise<BriefingFreshness> {
  if (target.kind !== "pr" || !target.headSha) return freshnessOf(target, { headSha: "", baseRef: "" });
  const now = await fetchPullRequestNow(client, target.repo, target.number, {
    headSha: target.headSha,
    ...(target.graphFrom === "merge" && target.baseSha ? { baseSha: target.baseSha } : {}),
  });
  return freshnessOf(target, now);
}
