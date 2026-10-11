import { FOLLOW_UPS_SCHEMA_VERSION, type ReviewThread, type ReviewThreads } from "@alden/schema";
import type { GitHubClient } from "./client.js";

/**
 * A PR's review threads with every comment, in one GraphQL request (two when it has more than 100 threads is rare
 * enough that Alden reads the first 100 and says nothing of the rest). Read only.
 */
export const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviewThreads(first: 100) {
        nodes {
          id
          path
          line
          startLine
          originalLine
          diffSide
          isResolved
          isOutdated
          viewerCanReply
          viewerCanResolve
          comments(first: 100) {
            nodes { id databaseId author { login } body createdAt url }
          }
        }
      }
    }
  }
}`;

export interface RawThread {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  diffSide: "LEFT" | "RIGHT";
  isResolved: boolean;
  isOutdated: boolean;
  viewerCanReply: boolean;
  viewerCanResolve: boolean;
  comments: {
    nodes: ({
      id: string;
      databaseId: number | null;
      author: { login: string } | null;
      body: string;
      createdAt: string;
      url: string;
    } | null)[];
  };
}

export interface RawThreadsPullRequest {
  headRefOid: string;
  reviewThreads: { nodes: (RawThread | null)[] };
}

const same = (a: string | undefined, b: string) => a !== undefined && a.toLowerCase() === b.toLowerCase();

/** GitHub's threads in Alden's shape: comments oldest first, and which are the viewer's. */
export function toReviewThreads(
  repo: string,
  number: number,
  viewer: string,
  pr: RawThreadsPullRequest,
): ReviewThreads {
  const threads: ReviewThread[] = pr.reviewThreads.nodes.flatMap((t): ReviewThread[] => {
    if (!t) return [];
    const comments = t.comments.nodes
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .map((c) => ({
        id: c.id,
        databaseId: c.databaseId,
        author: c.author?.login ?? null,
        isYou: same(c.author?.login, viewer),
        body: c.body,
        createdAt: new Date(c.createdAt).toISOString(),
        url: c.url,
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (comments.length === 0) return [];
    return [
      {
        id: t.id,
        path: t.path,
        line: t.line,
        startLine: t.startLine,
        originalLine: t.originalLine,
        side: t.diffSide === "LEFT" ? "LEFT" : "RIGHT",
        isResolved: t.isResolved,
        isOutdated: t.isOutdated,
        startedByYou: comments[0]?.isYou ?? false,
        viewerCanReply: t.viewerCanReply,
        viewerCanResolve: t.viewerCanResolve,
        comments,
      },
    ];
  });
  return {
    schemaVersion: FOLLOW_UPS_SCHEMA_VERSION,
    pr: `${repo}#${number}`,
    headSha: pr.headRefOid,
    viewer,
    threads,
  };
}

/** A PR's review threads, or undefined when the PR is gone or hidden from this sign-in. */
export async function fetchReviewThreads(
  client: GitHubClient,
  repo: string,
  number: number,
  viewer: string,
): Promise<ReviewThreads | undefined> {
  const [owner, name] = repo.split("/") as [string, string];
  try {
    const data = await client.graphql<{ repository: { pullRequest: RawThreadsPullRequest | null } | null }>(
      THREADS_QUERY,
      { owner, name, number },
    );
    const pr = data.repository?.pullRequest;
    return pr ? toReviewThreads(repo, number, viewer, pr) : undefined;
  } catch (error) {
    const errors = (error as { errors?: { type?: string }[] }).errors;
    if (errors?.some((e) => e.type === "NOT_FOUND")) return undefined;
    throw error;
  }
}

/** Threads you started, or replied in. */
export const yourThreads = (threads: ReviewThread[]) =>
  threads.filter((t) => t.startedByYou || t.comments.some((c) => c.isYou));

/** Whether someone else has had the last word on a thread you're in. */
export const repliedToYou = (thread: ReviewThread) => {
  const last = thread.comments.at(-1);
  return last !== undefined && !last.isYou && thread.comments.some((c) => c.isYou);
};
