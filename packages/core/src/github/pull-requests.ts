import { type CodeownersRule, isOwner, ownersOf } from "./codeowners.js";

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
  repository { nameWithOwner }
  author { login }
  labels(first: 20) { nodes { name } }
  files(first: ${MAX_FILES}) { nodes { path additions deletions } pageInfo { hasNextPage } }
  reviewRequests(first: 20) {
    nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug organization { login } } } }
  }
  reviews(last: 20) { nodes { author { login } state submittedAt } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
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
  repository: { nameWithOwner: string };
  author: { login: string } | null;
  labels: { nodes: { name: string }[] };
  files: { nodes: { path: string; additions: number; deletions: number }[]; pageInfo: { hasNextPage: boolean } } | null;
  reviewRequests: { nodes: { requestedReviewer: Reviewer | null }[] };
  reviews: { nodes: { author: { login: string } | null; state: string; submittedAt: string | null }[] };
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
  timelineItems: { nodes: ({ createdAt: string; requestedReviewer: Reviewer | null } | Record<string, never>)[] };
}

export type CiState = "success" | "failure" | "pending" | "none";

/** Everything the ranking needs to know about one PR waiting on the viewer. */
export interface PullRequestFacts {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  baseRef: string;
  headRef: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: { path: string; additions: number; deletions: number }[];
  filesTruncated: boolean;
  labels: string[];
  ci: CiState;
  mergeable: "mergeable" | "conflicting" | "unknown";
  reviews: { author: string | null; state: string; submittedAt: string | null }[];
  request: {
    /** The viewer was asked by name. */
    direct: boolean;
    /** The viewer's teams that were asked, as `org/slug`. */
    teams: string[];
    /** When the viewer (or one of their teams) was most recently asked. */
    requestedAt: string | null;
  };
  /** Changed files the viewer owns through CODEOWNERS, directly or via a team. */
  codeownedFiles: string[];
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

function ciState(raw: RawPullRequest): CiState {
  const state = raw.commits.nodes[0]?.commit.statusCheckRollup?.state;
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
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
    ci: ciState(raw),
    mergeable: raw.mergeable.toLowerCase() as PullRequestFacts["mergeable"],
    reviews: raw.reviews.nodes.map((r) => ({
      author: r.author?.login ?? null,
      state: r.state,
      submittedAt: r.submittedAt,
    })),
    request: { direct, teams, requestedAt },
    codeownedFiles: files
      .map((f) => f.path)
      .filter((path) => isOwner(ownersOf(codeowners, path), viewer.login, viewer.teams)),
  };
}
