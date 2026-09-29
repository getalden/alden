import type { AldenConfig, Briefing } from "@alden/schema";
import { fetchPullRequestDiff, readLocalDiff } from "../diff/sources.js";
import type { GitHubClient } from "../github/client.js";
import { PULL_REQUEST_FIELDS, type RawPullRequest, toFacts } from "../github/pull-requests.js";
import { fetchViewer } from "../github/queue.js";
import type { SpendLedger } from "../llm/ledger.js";
import type { LlmProvider } from "../llm/provider.js";
import { buildBriefing } from "./briefing.js";
import type { ManifestSnapshot } from "./dependencies.js";
import { addModelReview } from "./llm/run.js";
import { loadLocalManifests, loadPullRequestManifests } from "./manifests.js";

/** Ask a model too. Without it, the briefing is the deterministic checks alone. */
export interface WithModel {
  provider: LlmProvider;
  ledger: SpendLedger;
}

/** One PR's facts by number: the queue's fields plus its description, which only a review needs. */
export async function fetchPullRequest(
  client: GitHubClient,
  repo: string,
  number: number,
): Promise<RawPullRequest & { body: string }> {
  const [owner, name] = repo.split("/");
  const notFound = new Error(`Couldn't find ${repo}#${number}. Check the number, and that you can see the repo.`);
  let data: { repository: { pullRequest: (RawPullRequest & { body: string }) | null } | null };
  try {
    data = await client.graphql(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PULL_REQUEST_FIELDS} body } }
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

/** A briefing for one PR on GitHub. */
export async function reviewPullRequest(
  client: GitHubClient,
  repo: string,
  number: number,
  config: AldenConfig,
  model?: WithModel,
): Promise<Briefing> {
  // The PR first, so a wrong number gets a clear message rather than the files API's bare "Not Found".
  const raw = await fetchPullRequest(client, repo, number);
  const [{ viewer }, files] = await Promise.all([fetchViewer(client), fetchPullRequestDiff(client, repo, number)]);
  const pr = toFacts(raw, viewer);
  const manifests = await tryManifests(() => loadPullRequestManifests(client, repo, number, files));
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
    },
    files,
    pr,
    config,
    ...(manifests ? { manifests } : {}),
  });
  if (!model) return briefing;
  return addModelReview(briefing, { ...model, config, files, description: raw.body });
}

/** A briefing for everything that differs from HEAD in the working tree around `cwd`. */
export async function reviewLocalChanges(
  config: AldenConfig,
  cwd: string = process.cwd(),
  model?: WithModel,
): Promise<Briefing> {
  const { repoRoot, branch, files } = await readLocalDiff(cwd);
  const manifests = await tryManifests(() => loadLocalManifests(repoRoot, files));
  const briefing = buildBriefing({
    target: { kind: "local", repoRoot, branch },
    files,
    config,
    ...(manifests ? { manifests } : {}),
  });
  if (!model) return briefing;
  return addModelReview(briefing, { ...model, config, files });
}
