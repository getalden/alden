import { type AgentMarker, agentMarker, prAuthor } from "@alden/schema";
import type { JsonCache } from "../cache.js";
import type { GitHubClient } from "./client.js";
import type { RawPullRequest } from "./pull-requests.js";

/**
 * Reading AI agents' markers for the queue: a PR's description and its last commit's message, for the PRs whose
 * author and branch don't already say who wrote them. They're a separate, small request rather than part of the
 * queue's details: a description is as big as the rest of a PR's details put together (2.1 KB against 1.9 KB on
 * average across the recorded fixtures), and most PRs (bots', agents' own, those on an agent's branch) don't need
 * them. Only the agent found is kept, in the cache by head commit; the text is never stored or sent anywhere.
 */

/** A PR's head commit doesn't change, and neither does its last commit's message; an edited description is read again after the next push. */
const MARKER_MS = 7 * 24 * 3_600_000;

const MARKERS_QUERY = `
  query($ids: [ID!]!) {
    nodes(ids: $ids) { ... on PullRequest { id body commits(last: 1) { nodes { commit { message } } } } }
  }
`;

interface RawMarkerText {
  id: string;
  body: string | null;
  commits: { nodes: { commit: { message: string } }[] };
}

/** A PR as the queue knows it before its markers are read. */
export interface MarkerTarget {
  id: string;
  repo: string;
  number: number;
  /** The head commit, which the cache is keyed by. Without it nothing is cached. */
  headOid?: string;
}

/** True when nothing but a marker can say an agent wrote the PR: a person's (or your) PR off an agent's branch. */
export function needsMarkers(raw: Pick<RawPullRequest, "author" | "headRefName">): boolean {
  const author = prAuthor({
    author: raw.author?.login ?? null,
    authorIsBot: raw.author?.__typename === "Bot",
    headRef: raw.headRefName,
  });
  return author?.kind === "person" || author?.kind === "you";
}

const cacheKey = (pr: MarkerTarget) => `agent-marker:v1:${pr.repo}#${pr.number}@${pr.headOid}`;

/**
 * The agent marked on each PR, by node id, for the PRs given: from the cache by head commit, the rest in one request.
 * PRs with no marker are left out of the result.
 */
export async function fetchAgentMarkers(
  client: GitHubClient,
  prs: MarkerTarget[],
  cache?: JsonCache,
): Promise<{ markers: Map<string, AgentMarker>; cached: number; read: number }> {
  const markers = new Map<string, AgentMarker>();
  const missing: MarkerTarget[] = [];
  let cached = 0;
  for (const pr of prs) {
    const hit = pr.headOid ? await cache?.get<{ marker: AgentMarker | null }>(cacheKey(pr), MARKER_MS) : undefined;
    if (!hit) {
      missing.push(pr);
      continue;
    }
    cached++;
    if (hit.marker) markers.set(pr.id, hit.marker);
  }
  if (missing.length === 0) return { markers, cached, read: 0 };

  const data = await client.graphql<{ nodes: (RawMarkerText | null)[] }>(MARKERS_QUERY, {
    ids: missing.map((pr) => pr.id),
  });
  const byId = new Map(
    data.nodes.filter((n): n is RawMarkerText => n !== null && "id" in n && n.id !== undefined).map((n) => [n.id, n]),
  );
  for (const pr of missing) {
    const node = byId.get(pr.id);
    if (!node) continue;
    const marker =
      agentMarker({ description: node.body, commitMessage: node.commits?.nodes[0]?.commit.message }) ?? null;
    if (marker) markers.set(pr.id, marker);
    if (pr.headOid) await cache?.set(cacheKey(pr), { marker });
  }
  return { markers, cached, read: missing.length };
}
