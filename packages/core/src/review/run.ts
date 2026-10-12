import type { AldenConfig, Briefing, DraftTone } from "@alden/schema";
import type { DiffFile } from "../diff/parse.js";
import { fetchPullRequestDiff, readLocalDiff } from "../diff/sources.js";
import type { GitHubClient } from "../github/client.js";
import { PULL_REQUEST_FIELDS, type RawPullRequest, toFacts } from "../github/pull-requests.js";
import { fetchViewer } from "../github/queue.js";
import { type Checkout, checkoutPullRequest, type GraphFrom, withCheckoutLock } from "../graph/checkout.js";
import { findClone } from "../graph/clones.js";
import type { Learning } from "../learn/learn.js";
import type { SpendLedger } from "../llm/ledger.js";
import type { Effort, LlmProvider } from "../llm/provider.js";
import { buildBriefing } from "./briefing.js";
import type { ManifestSnapshot } from "./dependencies.js";
import { buildGraphReview, type GraphReview } from "./graph-context.js";
import { addModelReview } from "./llm/run.js";
import { loadLocalManifests, loadPullRequestManifests } from "./manifests.js";

/** Ask a model too. Without it, the briefing is the deterministic checks alone. */
export interface WithModel {
  provider: LlmProvider;
  ledger: SpendLedger;
  /** A one-off effort, overriding `model.effort` from config. */
  effort?: Effort;
  /** The tone of the briefing's drafted comments: the repo's (see `toneFor`), else `drafts.tone`. */
  tone?: DraftTone;
}

/** What a review needs beyond the queue's fields: the description, and the commits the code graph is built from. */
export interface PullRequestDetail {
  body: string;
  headRefOid: string;
  /** GitHub's merge of the PR onto its latest base (`refs/pull/N/merge`); null when it conflicts or isn't made yet. */
  potentialMergeCommit: { oid: string } | null;
}

/** One PR's facts by number: the queue's fields plus what only a review needs. */
export async function fetchPullRequest(
  client: GitHubClient,
  repo: string,
  number: number,
): Promise<RawPullRequest & PullRequestDetail> {
  const [owner, name] = repo.split("/");
  const notFound = new Error(`Couldn't find ${repo}#${number}. Check the number, and that you can see the repo.`);
  let data: { repository: { pullRequest: (RawPullRequest & PullRequestDetail) | null } | null };
  try {
    data = await client.graphql(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) { pullRequest(number: $number) {
          ${PULL_REQUEST_FIELDS} body headRefOid potentialMergeCommit { oid }
        } }
      }`,
      { owner, name, number },
    );
  } catch (error) {
    // GitHub answers a missing repo or PR with a GraphQL "Could not resolve" error rather than null.
    if (/Could not resolve/i.test((error as Error).message)) throw notFound;
    throw error;
  }
  const pr = data.repository?.pullRequest;
  if (!pr) throw notFound;
  return pr;
}

/** Manifests are a best effort: if they can't be read, the dependency check says so instead of failing the review. */
async function tryManifests(load: () => Promise<ManifestSnapshot[]>): Promise<ManifestSnapshot[] | undefined> {
  try {
    return await load();
  } catch {
    return undefined;
  }
}

/** A step of a review, for progress displays. */
export type ReviewStage = "fetch" | "graph" | "checks" | "model";

/**
 * Whether and where to build the code graph (on by default; `cwd` must be inside a clone for PR reviews), and a
 * callback as the review moves through its stages.
 */
export interface GraphOptions {
  enabled?: boolean;
  cwd?: string;
  onStage?: (stage: ReviewStage, label: string) => void;
  /** What Alden has learned about the reviewer in this repo (see `loadLearning`). Absent: a briefing for anyone. */
  learning?: Learning;
  /** Given a PR's diff as the briefing saw it, for placing Alden's drafted comments on it (see `makeAldenDrafts`). */
  onDiff?: (files: DiffFile[]) => void;
}

type GraphResult = {
  graph?: GraphReview;
  unavailable?: string;
  /** For a PR: what the graph was built from. */
  from?: { graphFrom: GraphFrom; baseSha?: string; note?: string };
};

/** Builds the graph at `root`, or explains why not, without ever failing the review. */
async function tryGraph(
  root: Promise<Checkout | { ok: true; root: string; graphFrom?: undefined }>,
  files: DiffFile[],
): Promise<GraphResult> {
  try {
    const checkout = await root;
    if (!checkout.ok) return { unavailable: checkout.reason };
    const graph = await buildGraphReview(checkout.root, files);
    if (!checkout.graphFrom) return { graph };
    const { graphFrom, baseSha, note } = checkout;
    return { graph, from: { graphFrom, ...(baseSha ? { baseSha } : {}), ...(note ? { note } : {}) } };
  } catch (error) {
    return { unavailable: `The code graph failed to build (${(error as Error).message.slice(0, 160)}).` };
  }
}

/** Why a PR's callers weren't checked when Alden knows no clone of its repo. */
export function noCloneReason(repo: string): string {
  return `No local clone of ${repo} found, so callers outside the diff weren't checked. Run Alden once in a clone of it, or tell Alden where your clones live: \`alden config set clones.folders ~/src\`.`;
}

const graphFields = (g: GraphResult) => ({
  ...(g.graph ? { graph: g.graph.context } : {}),
  ...(g.unavailable ? { graphUnavailable: g.unavailable } : {}),
  ...(g.from?.note ? { graphNote: g.from.note } : {}),
});

/** A briefing for one PR on GitHub. */
export async function reviewPullRequest(
  client: GitHubClient,
  repo: string,
  number: number,
  config: AldenConfig,
  model?: WithModel,
  graphOptions: GraphOptions = {},
): Promise<Briefing> {
  const stage = graphOptions.onStage ?? (() => {});
  stage("fetch", `Fetching ${repo}#${number}`);
  // The PR first, so a wrong number gets a clear message rather than the files API's bare "Not Found".
  const raw = await fetchPullRequest(client, repo, number);
  const [{ viewer }, files] = await Promise.all([fetchViewer(client), fetchPullRequestDiff(client, repo, number)]);
  const pr = toFacts(raw, viewer);
  graphOptions.onDiff?.(files);
  if (graphOptions.enabled !== false) stage("graph", "Checking out the PR and finding callers");
  const [manifests, graph] = await Promise.all([
    tryManifests(() => loadPullRequestManifests(client, repo, number, files)),
    graphOptions.enabled === false
      ? Promise.resolve<GraphResult>({})
      : withCheckoutLock(async () => {
          const clone = await findClone(repo, {
            cwd: graphOptions.cwd ?? process.cwd(),
            folders: config.clones.folders,
          }).catch(() => undefined);
          if (!clone) return { unavailable: noCloneReason(repo) };
          return tryGraph(
            checkoutPullRequest(clone.path, repo, number, {
              baseRef: raw.baseRefName,
              headSha: raw.headRefOid,
              ...(raw.potentialMergeCommit ? { mergeSha: raw.potentialMergeCommit.oid } : {}),
              mergeable: raw.mergeable,
              pin: files.filter((f) => f.status !== "removed").map((f) => f.path),
            }),
            files,
          );
        }),
  ]);
  stage("checks", "Running checks");
  const briefing = buildBriefing({
    target: {
      kind: "pr",
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
      title: pr.title,
      author: pr.author,
      baseRef: pr.baseRef,
      headRef: pr.headRef,
      // What it was briefed against, so it can tell when it's out of date. The diff is GitHub's (the PR against where
      // it branched); only the graph sees the base as it is now.
      headSha: raw.headRefOid,
      ...(graph.from?.baseSha ? { baseSha: graph.from.baseSha } : {}),
      ...(graph.from ? { graphFrom: graph.from.graphFrom } : {}),
    },
    files,
    pr,
    description: raw.body,
    config,
    ...(manifests ? { manifests } : {}),
    ...graphFields(graph),
    ...(graphOptions.learning ? { learning: graphOptions.learning } : {}),
  });
  if (!model) return briefing;
  stage("model", `Asking ${model.provider.model}`);
  return addModelReview(briefing, {
    ...model,
    config,
    files,
    description: raw.body,
    ...(graphOptions.learning ? { learning: graphOptions.learning } : {}),
    ...(graph.graph?.callerSnippets ? { callerSnippets: graph.graph.callerSnippets } : {}),
  });
}

/** A briefing for everything that differs from HEAD in the working tree around `cwd`. */
export async function reviewLocalChanges(
  config: AldenConfig,
  cwd: string = process.cwd(),
  model?: WithModel,
  graphOptions: GraphOptions = {},
): Promise<Briefing> {
  const stage = graphOptions.onStage ?? (() => {});
  stage("fetch", "Reading your local changes");
  const { repoRoot, branch, files } = await readLocalDiff(cwd);
  if (graphOptions.enabled !== false && files.length > 0) stage("graph", "Finding callers");
  const [manifests, graph] = await Promise.all([
    tryManifests(() => loadLocalManifests(repoRoot, files)),
    graphOptions.enabled === false || files.length === 0
      ? Promise.resolve<GraphResult>({})
      : tryGraph(Promise.resolve({ ok: true as const, root: repoRoot }), files),
  ]);
  stage("checks", "Running checks");
  const briefing = buildBriefing({
    target: { kind: "local", repoRoot, branch },
    files,
    config,
    ...(manifests ? { manifests } : {}),
    ...graphFields(graph),
    ...(graphOptions.learning ? { learning: graphOptions.learning } : {}),
  });
  if (!model) return briefing;
  stage("model", `Asking ${model.provider.model}`);
  return addModelReview(briefing, {
    ...model,
    config,
    files,
    ...(graphOptions.learning ? { learning: graphOptions.learning } : {}),
    ...(graph.graph?.callerSnippets ? { callerSnippets: graph.graph.callerSnippets } : {}),
  });
}
