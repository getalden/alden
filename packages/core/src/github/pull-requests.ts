import type { CiState, PullRequestFacts } from "@alden/schema";
import { type CodeownersRule, isOwner, ownersOf } from "./codeowners.js";

export type { CiState, PullRequestFacts };

/** Files fetched per PR. Larger PRs are marked `filesTruncated`. */
export const MAX_FILES = 100;

/** The fields Alden reads for every PR, shared by the queue search and the fixture recorder. */
export const PULL_REQUEST_FIELDS = `
  number
  title
  url
  isDraft
  createdAt
  updatedAt
  additions
  deletions
  changedFiles
  mergeable
  baseRefName
  headRefName
  isCrossRepository
  repository { nameWithOwner }
  author { __typename login }
  labels(first: 20) { nodes { name } }
  assignees(first: 10) { nodes { login } }
  files(first: ${MAX_FILES}) { nodes { path additions deletions } pageInfo { hasNextPage } }
  reviewRequests(first: 20) {
    nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug organization { login } } } }
  }
  reviews(last: 20) { nodes { author { login } state submittedAt commit { oid } } }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          state
          contexts(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              __typename
              ... on CheckRun { name status conclusion }
              ... on StatusContext { context state }
            }
          }
        }
      }
    }
  }
  timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) {
    nodes {
      ... on ReviewRequestedEvent {
        createdAt
        requestedReviewer { __typename ... on User { login } ... on Team { slug organization { login } } }
      }
    }
  }
`;

type Reviewer =
  | { __typename: "User"; login: string }
  | { __typename: "Team"; slug: string; organization: { login: string } }
  | { __typename: "Bot" | "Mannequin" };

/** A pull request node as GitHub's GraphQL API returns it for `PULL_REQUEST_FIELDS`. */
export interface RawPullRequest {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  baseRefName: string;
  headRefName: string;
  isCrossRepository: boolean;
  repository: { nameWithOwner: string };
  author: { __typename?: string; login: string } | null;
  labels: { nodes: { name: string }[] };
  /** Absent in fixtures recorded before Alden read assignees. */
  assignees?: { nodes: { login: string }[] };
  files: { nodes: { path: string; additions: number; deletions: number }[]; pageInfo: { hasNextPage: boolean } } | null;
  reviewRequests: { nodes: { requestedReviewer: Reviewer | null }[] };
  reviews: {
    nodes: {
      author: { login: string } | null;
      state: string;
      submittedAt: string | null;
      /** Absent in fixtures recorded before Alden read it; null when GitHub no longer has the commit. */
      commit?: { oid: string } | null;
    }[];
  };
  commits: { nodes: { commit: { statusCheckRollup: StatusRollup | null } }[] };
  timelineItems: { nodes: ({ createdAt: string; requestedReviewer: Reviewer | null } | Record<string, never>)[] };
}

/** One check run or commit status in a rollup. */
type RollupContext =
  | { __typename: "CheckRun"; name: string; status: string; conclusion: string | null }
  | { __typename: "StatusContext"; context: string; state: string };

/** A commit's CI: GitHub's summary, and (absent in fixtures recorded before Alden read them) each run in it. */
interface StatusRollup {
  state: string;
  contexts?: { pageInfo: { hasNextPage: boolean }; nodes: (RollupContext | Record<string, never> | null)[] };
}

export interface Viewer {
  login: string;
  /** The viewer's teams as lowercase `org/slug`. */
  teams: ReadonlySet<string>;
}

function reviewerKey(reviewer: Reviewer | null): string | undefined {
  if (!reviewer) return undefined;
  if (reviewer.__typename === "User") return `user:${reviewer.login.toLowerCase()}`;
  if (reviewer.__typename === "Team") return `team:${reviewer.organization.login}/${reviewer.slug}`.toLowerCase();
  return undefined;
}

/** One run's outcome: a check run's conclusion (NEUTRAL and SKIPPED pass, as GitHub counts them), or a status. */
function outcome(context: RollupContext): CiState {
  if (context.__typename === "StatusContext") {
    return context.state === "SUCCESS"
      ? "success"
      : context.state === "PENDING" || context.state === "EXPECTED"
        ? "pending"
        : "failure";
  }
  if (context.status !== "COMPLETED" || context.conclusion === null) return "pending";
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(context.conclusion)) return "success";
  return context.conclusion === "CANCELLED" ? "cancelled" : "failure";
}

/**
 * CI that GitHub's rollup calls failing, from its runs: GitHub counts a cancelled run as a failure, but a cancelled run
 * isn't the author's to fix. A cancelled run of a check that ran again counts as that other run; any other failing run
 * makes it a failure; then anything still running makes it pending; then a cancelled run left makes it cancelled.
 * Failure, as GitHub says, when the runs aren't all there to read.
 */
function failingRollup(rollup: StatusRollup): CiState {
  const contexts = rollup.contexts;
  if (!contexts || contexts.pageInfo.hasNextPage) return "failure";
  const runs = contexts.nodes
    .filter((n): n is RollupContext => n !== null && "__typename" in n)
    .map((n) => ({ name: n.__typename === "CheckRun" ? n.name : n.context, outcome: outcome(n) }));
  const kept = runs.filter(
    (r) => r.outcome !== "cancelled" || !runs.some((o) => o.name === r.name && o.outcome !== "cancelled"),
  );
  for (const state of ["failure", "pending", "cancelled"] as const) {
    if (kept.some((r) => r.outcome === state)) return state;
  }
  // Every run left passed (a cancelled one ran again); with no runs to read, GitHub's word stands.
  return kept.length > 0 ? "success" : "failure";
}

function ciState(raw: RawPullRequest): CiState {
  const rollup = raw.commits.nodes[0]?.commit.statusCheckRollup;
  switch (rollup?.state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return failingRollup(rollup);
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "none";
  }
}

/** Turns a raw PR into facts from the viewer's point of view. Pure, so fixtures can test it. */
export function toFacts(raw: RawPullRequest, viewer: Viewer, codeowners: CodeownersRule[] = []): PullRequestFacts {
  const me = `user:${viewer.login.toLowerCase()}`;
  const mine = (key: string | undefined) =>
    key !== undefined && (key === me || (key.startsWith("team:") && viewer.teams.has(key.slice(5))));

  const requested = raw.reviewRequests.nodes.map((n) => reviewerKey(n.requestedReviewer)).filter(mine);
  const direct = requested.includes(me);
  const teams = requested.filter((k): k is string => k?.startsWith("team:") === true).map((k) => k.slice(5));

  const requestedAt =
    raw.timelineItems.nodes
      .filter((n): n is { createdAt: string; requestedReviewer: Reviewer | null } => "createdAt" in n)
      .filter((n) => mine(reviewerKey(n.requestedReviewer)))
      .map((n) => n.createdAt)
      .sort()
      .at(-1) ?? null;

  const files = raw.files?.nodes ?? [];

  return {
    repo: raw.repository.nameWithOwner,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: raw.author?.login ?? null,
    authorIsBot: raw.author?.__typename === "Bot",
    isDraft: raw.isDraft,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    baseRef: raw.baseRefName,
    headRef: raw.headRefName,
    additions: raw.additions,
    deletions: raw.deletions,
    changedFiles: raw.changedFiles,
    files,
    filesTruncated: raw.files?.pageInfo.hasNextPage ?? raw.changedFiles > 0,
    labels: raw.labels.nodes.map((l) => l.name),
    assignees: raw.assignees?.nodes.map((a) => a.login) ?? [],
    ci: ciState(raw),
    mergeable: raw.mergeable.toLowerCase() as PullRequestFacts["mergeable"],
    reviews: raw.reviews.nodes.map((r) => ({
      author: r.author?.login ?? null,
      state: r.state,
      submittedAt: r.submittedAt,
      ...(r.commit?.oid ? { commit: r.commit.oid } : {}),
    })),
    request: { direct, teams, requestedAt },
    codeownedFiles: files
      .map((f) => f.path)
      .filter((path) => isOwner(ownersOf(codeowners, path), viewer.login, viewer.teams)),
    stackedPrs: 0,
  };
}
