/**
 * The web UI over recorded public PRs instead of your GitHub account: `pnpm ui:demo [--port 4319]`.
 *
 * For working on the UI and taking screenshots. Nothing is fetched and no model is called: the queue is the recorded
 * PRs (with their wait times moved to recent hours so the ranking looks lived-in), reviews are the offline
 * deterministic briefings, and one PR gets an invented model section so its styling can be seen.
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUiServer, type UiApi } from "../packages/cli/src/ui/server.js";
import {
  buildBriefing,
  FeedbackLog,
  fromRestFile,
  loadConfig,
  mergeLookHere,
  type RawPullRequest,
  rankQueue,
  type StatsPullRequest,
  summarizeStats,
  toFacts,
} from "../packages/core/src/index.js";
import type { Briefing, PullRequestFacts } from "../packages/schema/src/index.js";

const ROOT = join(import.meta.dirname, "..");
const FIXTURES = join(ROOT, "packages/core/src/github/__fixtures__");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1] ?? 4319) || 4319;
const config = await loadConfig();
const viewer = { login: "you", teams: new Set<string>() };

const recorded = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json"))
  .flatMap((f) => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, f), "utf8")) as {
      name: string;
      pullRequests: (RawPullRequest & { body?: string })[];
    };
    return fixture.pullRequests.map((raw) => ({ name: fixture.name, raw }));
  });

// Spread the waits over the last few days, deterministically, so the ranking has something to rank.
const hour = 3_600_000;
const facts: PullRequestFacts[] = recorded.map(({ raw }, i) => {
  const pr = toFacts(raw, viewer);
  const asked = new Date(Date.now() - ((i * 37) % 130) * hour - hour).toISOString();
  return { ...pr, request: { ...pr.request, direct: i % 3 !== 0, requestedAt: asked } };
});

function briefingFor(repo: string, number: number): Briefing {
  const match = recorded.find(({ raw }) => raw.repository.nameWithOwner === repo && raw.number === number);
  if (!match) throw new Error(`${repo}#${number} isn't one of the recorded PRs.`);
  const files = (
    JSON.parse(readFileSync(join(FIXTURES, "diffs", `${match.name}-${number}.json`), "utf8")) as Parameters<
      typeof fromRestFile
    >[0][]
  ).map(fromRestFile);
  const pr = toFacts(match.raw, viewer);
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
    manifests: [],
    graphUnavailable: "Demo mode: the code graph needs a clone of the repo.",
  });
  const first = files.find((f) => f.hunks.length > 0);
  const line = first?.hunks[0]?.lines.find((l) => l.kind === "add")?.newLine;
  if (number % 2 === 1 && first && line) {
    const findings = [
      {
        title: "Example model finding",
        detail: "Model findings appear with their severity and every place they point at.",
        severity: "medium" as const,
        anchors: [{ path: first.path, line }],
      },
    ];
    return {
      ...briefing,
      needsYourEyes: mergeLookHere(briefing.needsYourEyes, briefing.checks, findings),
      llm: {
        status: "ok",
        provider: "anthropic",
        model: "claude-sonnet-5",
        effort: "medium",
        summary: `(Invented for the demo.) ${pr.title}. The change touches ${files.length} files; this paragraph shows where the model's summary appears.`,
        matchesTitle: { verdict: "partly", reason: "An example verdict, so the styling can be seen." },
        findings,
        droppedFindings: 1,
        omittedFiles: [],
        usd: 0.0412,
      },
    };
  }
  return briefing;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Feedback given in the demo goes to a throwaway folder, never your real log.
const feedback = new FeedbackLog(mkdtempSync(join(tmpdir(), "alden-demo-feedback-")));

const api: UiApi = {
  session: async () => ({
    version: "demo",
    cwd: ROOT,
    repo: { root: ROOT, repos: ["getalden/alden"] },
    user: { login: "you", source: "demo" },
    model: {
      provider: "anthropic",
      name: "sonnet",
      id: "claude-sonnet-5",
      effort: "medium",
      supportsEffort: true,
      available: true,
    },
    aliases: { sonnet: "claude-sonnet-5", opus: "claude-opus-5", haiku: "claude-haiku-4-5", fable: "claude-fable-5-1" },
    efforts: ["low", "medium", "high", "xhigh", "max"],
    budget: { perReviewUsd: 0.5, dailyUsd: 10, spentToday: 0.37 },
  }),
  queue: async () =>
    rankQueue({ viewer: "you", fetchedAt: new Date().toISOString(), pullRequests: facts, warnings: [] }, config.queue),
  review: async (request, onStage) => {
    const ref = /^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:#|\/pull\/)(\d+)$/.exec(request.pr ?? "");
    if (!ref?.[1] || !ref[2]) throw new Error("Demo mode reviews recorded PRs only (owner/repo#123).");
    onStage("fetch", `Fetching ${ref[1]}#${ref[2]}`);
    await sleep(400);
    if (request.graph !== false) {
      onStage("graph", "Checking out the PR and finding callers");
      await sleep(700);
    }
    onStage("checks", "Running checks");
    await sleep(200);
    if (request.llm !== false) {
      onStage("model", "Asking claude-sonnet-5");
      await sleep(1_200);
    }
    const { llm, ...briefing } = briefingFor(ref[1], Number(ref[2]));
    return request.llm === false || !llm ? briefing : { ...briefing, llm };
  },
  spend: async () => ({
    today: new Date().toISOString().slice(0, 10),
    spentToday: 0.37,
    dailyUsd: 10,
    perReviewUsd: 0.5,
    byModel: [{ model: "claude-sonnet-5", calls: 8, usd: 0.37 }],
    lastDays: [],
  }),
  addFeedback: (input) => feedback.add(input),
  feedbackSummary: () => feedback.summary(),
  // Invented PRs, so the Stats view has a before and after to show: waits drift down after the split.
  stats: async ({ repo, days }) => {
    const now = new Date();
    const split = new Date(now.getTime() - 45 * 24 * hour);
    const prs: StatsPullRequest[] = Array.from({ length: 160 }, (_, i) => {
      const opened = new Date(now.getTime() - ((i * 13.7) % days) * 24 * hour);
      const after = opened >= split;
      const wait = ((i * 37) % 97) * (after ? 0.6 : 1.4) + 2;
      const at = (h: number) => new Date(opened.getTime() + h * hour).toISOString();
      return {
        number: i + 1,
        createdAt: opened.toISOString(),
        state: i % 11 === 0 ? "OPEN" : "MERGED",
        isDraft: false,
        author: { login: `dev${i % 7}`, __typename: "User" },
        readyEvents: [],
        reviews:
          i % 11 === 0
            ? []
            : [
                { author: { login: "you", __typename: "User" }, state: "COMMENTED", submittedAt: at(wait) },
                { author: { login: "kim", __typename: "User" }, state: "APPROVED", submittedAt: at(wait * 2.5) },
              ],
      };
    });
    return summarizeStats({
      repo: repo ?? "getalden/alden",
      prs,
      from: new Date(now.getTime() - days * 24 * hour),
      to: now,
      split: { at: split.toISOString(), source: "first-use" },
      truncated: false,
      now,
    });
  },
  config: async () => ({ path: "(demo)", config }),
  setConfig: async () => ({ path: "(demo)", config }),
};

const ui = await startUiServer({ api, staticDir: join(ROOT, "packages/ui/dist"), port, token: "demo" });
console.log(`Alden demo UI at ${ui.url}  (build the UI first: pnpm --filter @alden/ui build)`);
