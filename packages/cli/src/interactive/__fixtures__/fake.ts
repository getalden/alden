import type {
  Briefing,
  FeedbackInput,
  RankedPullRequest,
  RankedQueue,
  ReviewDraft,
  ReviewEvent,
} from "@alden/schema";
import type { DraftInput } from "../../ui/server.js";
import type { Engine, ModelChoice, PendingReview } from "../engine.js";

/** A queue, a briefing and an engine that answers from them: no GitHub, model or keychain. */

export const row = (
  number: number,
  pr: Partial<RankedPullRequest["pr"]> = {},
  extra: Partial<RankedPullRequest> = {},
): RankedPullRequest => ({
  pr: {
    repo: "acme/api",
    number,
    title: `PR ${number}`,
    url: `https://github.com/${pr.repo ?? "acme/api"}/pull/${number}`,
    author: "sam",
    authorIsBot: false,
    isDraft: false,
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:00Z",
    baseRef: "main",
    headRef: "feature",
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
  lane: "needs-you",
  score: { risk: 1, wait: 1, blocking: 0, total: 2 },
  reasons: ["touches payments"],
  waitingHours: 26,
  waitingOnAuthor: false,
  ...extra,
});

export const queue: RankedQueue = {
  schemaVersion: 1,
  viewer: "me",
  fetchedAt: "2026-10-12T10:00:00Z",
  needsYou: [
    row(12, { title: "Charge cards in cents", additions: 120, deletions: 10 }),
    row(7, { repo: "acme/web", title: "Fix the login redirect", author: "lee" }, { reasons: ["blocks 2 PRs"] }),
    row(31, { title: "Retry webhooks with backoff", ci: "failure" }, { reasons: ["CI failing: ping @sam"] }),
  ],
  fastTrack: [
    row(
      15,
      { title: "Bump lodash", author: "dependabot[bot]", authorIsBot: true, additions: 2, deletions: 2 },
      { lane: "fast-track", fastTrack: "dependency patch bump", reasons: [] },
    ),
  ],
  warnings: [],
};

/** The queue with Your turn: a PR you reviewed where the author replied. */
export const queueWithYourTurn: RankedQueue = {
  ...queue,
  yourTurn: [
    {
      pr: "acme/api#3",
      repo: "acme/api",
      number: 3,
      title: "Cache the price list",
      url: "https://github.com/acme/api/pull/3",
      news: { text: "@sam replied to your comment", at: "2026-10-12T08:00:00Z", replies: 1, resolved: 0, outdated: 0, events: ["reply"] },
    },
  ],
};

export function briefing(overrides: Partial<Briefing> = {}): Briefing {
  return {
    schemaVersion: 1,
    target: {
      kind: "pr",
      repo: "acme/api",
      number: 12,
      url: "https://github.com/acme/api/pull/12",
      title: "Charge cards in cents",
      author: "sam",
      baseRef: "main",
      headRef: "sam/cents",
    },
    generatedAt: "2026-10-12T10:05:00Z",
    summary: { files: 2, additions: 120, deletions: 10, reviewableAdditions: 120, reviewableDeletions: 10 },
    files: [
      {
        path: "src/pay.ts",
        status: "modified",
        kind: "code",
        additions: 100,
        deletions: 10,
        binary: false,
        patchMissing: false,
      },
      {
        path: "src/pay.test.ts",
        status: "added",
        kind: "test",
        additions: 20,
        deletions: 0,
        binary: false,
        patchMissing: false,
      },
    ],
    checks: [
      {
        id: "signatures.changed",
        title: "Changed public signatures",
        status: "flagged",
        severity: "high",
        summary: "charge() changed and is still called from 2 files.",
        evidence: [{ text: "changed: charge(amount) → charge(cents)", anchor: { path: "src/pay.ts", line: 12 } }],
        heuristic: false,
      },
      {
        id: "tests.missing",
        title: "Code changed without tests",
        status: "passed",
        severity: "info",
        summary: "1 test file changed alongside 1 code file.",
        evidence: [],
        heuristic: true,
      },
    ],
    needsYourEyes: [
      {
        title: "charge() changed: still called from src/cart.ts",
        reason: "A caller outside the diff passes dollars.",
        source: "check",
        checkId: "signatures.changed",
        anchor: { path: "src/pay.ts", line: 12 },
      },
      {
        title: "Refunds round to the cent",
        reason: "Rounding moved from the API to the client.",
        source: "check",
        checkId: "money.rounding",
        anchor: { path: "src/refund.ts", line: 40 },
      },
    ],
    notChecked: ["Whether the migration runs on a large table"],
    ...overrides,
  } as Briefing;
}

export const withModel = (): Briefing =>
  briefing({
    llm: {
      status: "ok",
      model: "claude-sonnet",
      provider: "anthropic",
      summary: "Moves money to integer cents.",
      findings: [],
      droppedFindings: 0,
      omittedFiles: [],
      usd: 0.0042,
    },
  } as Partial<Briefing>);

export function draft(overrides: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    id: "d1",
    pr: "acme/api#12",
    headSha: "abc1234def",
    path: "src/pay.ts",
    line: 12,
    side: "RIGHT",
    body: "Is this in cents?",
    source: "you",
    createdAt: "2026-10-12T10:06:00Z",
    updatedAt: "2026-10-12T10:06:00Z",
    state: "draft",
    ...overrides,
  };
}

export interface Calls {
  queue: boolean[];
  brief: { pr: string; llm: boolean }[];
  feedback: FeedbackInput[];
  comment: DraftInput[];
  pending: string[];
  send: { pr: string; event: ReviewEvent }[];
  open: string[];
}

/** An engine that answers from the fixtures, and remembers what it was asked. */
export function fakeEngine(
  options: { model?: ModelChoice; pending?: PendingReview; failQueue?: string } = {},
): Engine & { calls: Calls } {
  const calls: Calls = { queue: [], brief: [], feedback: [], comment: [], pending: [], send: [], open: [] };
  const drafts: ReviewDraft[] = [];
  return {
    calls,
    async queue(refresh, onProgress) {
      calls.queue.push(refresh);
      onProgress("Checking acme/api (1 of 2)…");
      if (options.failQueue) throw new Error(options.failQueue);
      return queue;
    },
    async brief(pr, llm, onProgress) {
      calls.brief.push({ pr, llm });
      onProgress("Building the code graph…");
      return llm ? withModel() : briefing();
    },
    model: async () =>
      options.model ?? { available: true, model: "claude-sonnet", perReviewUsd: 0.5, dailyUsd: 10, spentToday: 1.2 },
    async feedback(input) {
      calls.feedback.push(input);
      return { progress: "1 of 3: two more like this and Alden will put them first." };
    },
    async comment(input) {
      calls.comment.push(input);
      const { path: _, line: __, ...note } = draft({ id: `d${drafts.length + 1}`, body: input.body });
      const made: ReviewDraft = {
        ...note,
        ...(input.path ? { path: input.path } : {}),
        ...(input.line ? { line: input.line } : {}),
      };
      drafts.push(made);
      return made;
    },
    async pending(pr) {
      calls.pending.push(pr);
      return options.pending ?? { drafts: [...drafts], unaddressed: [], threads: [], unkept: 0 };
    },
    async send(pr, event) {
      calls.send.push({ pr, event });
      return { url: "https://github.com/acme/api/pull/12#pullrequestreview-1", posted: drafts.length, review: event };
    },
    open(url) {
      calls.open.push(url);
    },
  };
}
