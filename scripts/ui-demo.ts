/**
 * The web UI over recorded public PRs instead of your GitHub account: `pnpm ui:demo [--port 4319]`.
 *
 * For working on the UI and taking screenshots. Nothing is fetched and no model is called: the queue is the recorded
 * PRs (with their wait times moved to recent hours so the ranking looks lived-in), reviews are the offline
 * deterministic briefings, and one PR gets an invented model section so its styling can be seen. A throwaway
 * database is seeded with feedback, opens and notes for vercel/next.js, so learning and the Memory view have
 * something to show.
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefingFileName, briefingMarkdown } from "../packages/cli/src/render/markdown.js";
import { saveToDownloads } from "../packages/cli/src/ui/api.js";
import { createRankingApi } from "../packages/cli/src/ui/rank.js";
import { startUiServer, type UiApi } from "../packages/cli/src/ui/server.js";
import {
  addNote,
  buildBriefing,
  editNote,
  FeedbackLog,
  forget,
  forgetAll,
  fromRestFile,
  type Learning,
  loadConfig,
  loadLearning,
  localDiffView,
  memoryItems,
  memoryRepos,
  mergeLookHere,
  openStore,
  prFeatures,
  queueRows,
  type RawPullRequest,
  rankQueue,
  recordReaction,
  redactFeedback,
  restore,
  type StatsPullRequest,
  setLearning,
  summarizeStats,
  toDiffView,
  toFacts,
} from "../packages/core/src/index.js";
import {
  type Briefing,
  FEEDBACK_SCHEMA_VERSION,
  MEMORY_SCHEMA_VERSION,
  type PullRequestFacts,
} from "../packages/schema/src/index.js";

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

function briefingFor(repo: string, number: number, learning?: Learning, withModel = true): Briefing {
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
    ...(learning ? { learning } : {}),
  });
  const first = files.find((f) => f.hunks.length > 0);
  const line = first?.hunks[0]?.lines.find((l) => l.kind === "add")?.newLine;
  if (withModel && number % 2 === 1 && first && line) {
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
// Feedback and memory in the demo go to a throwaway database, never your real one.
const store = openStore(join(mkdtempSync(join(tmpdir(), "alden-demo-")), "alden.db"));
const feedback = new FeedbackLog(store);
const DEMO_REPO = "vercel/next.js";

// What a reviewer of next.js might have taught Alden over a few weeks.
const seeded = (day: number) => new Date(Date.now() - day * 24 * hour).toISOString();
for (const [i, [checkId, verdict]] of (
  [
    ["tests.missing", "not_needed"],
    ["tests.missing", "not_needed"],
    ["tests.missing", "not_needed"],
    ["config.changed", "agree"],
    ["config.changed", "agree"],
    ["config.changed", "agree"],
  ] as const
).entries()) {
  const at = seeded(20 - i);
  store.addEvent({
    id: `seed-feedback-${i}`,
    at,
    type: "feedback",
    repo: DEMO_REPO,
    body: {
      schemaVersion: FEEDBACK_SCHEMA_VERSION,
      id: `seed-feedback-${i}`,
      at,
      kind: "verdict",
      target: { kind: "pr", repo: DEMO_REPO, number: 90_000 + i },
      briefingAt: at,
      item: { source: "check", checkId, title: `${checkId} example`, anchor: { path: `x${i}` }, placement: "eyes" },
      verdict,
    },
  });
}
const lifted = facts.find((pr) => pr.repo === DEMO_REPO && pr.author);
if (lifted) {
  const author = prFeatures(lifted, config.queue.sensitivePaths).find((f) => f.startsWith("author:"));
  for (const i of [1, 2, 3]) {
    const at = seeded(10 - i);
    store.addEvent({
      id: `seed-open-${i}`,
      at,
      type: "open",
      repo: DEMO_REPO,
      body: {
        schemaVersion: MEMORY_SCHEMA_VERSION,
        id: `seed-open-${i}`,
        at,
        repo: DEMO_REPO,
        number: 80_000 + i,
        position: 3,
        features: author ? [author] : [],
        via: "ui",
      },
    });
  }
}
addNote(store, DEMO_REPO, "Server actions must check the session before they touch data.");
addNote(store, DEMO_REPO, "Changes under examples/ don't ship; a quick look is enough.");

const learningFor = (repo: string) => loadLearning(store, repo);
const memoryOf = async (repo = DEMO_REPO) => {
  const learning = await loadLearning(store, repo);
  return { repo, items: memoryItems(learning), paused: learning.paused, path: "~/.alden/alden.db (demo)" };
};
let demoConsent: "on" | "off" | "unset" = "unset";
// ALDEN_DEMO_DESKTOP=1 shows the desktop app's extras: Django's briefing was "prepared in the background".
const DEMO_DESKTOP = process.env.ALDEN_DEMO_DESKTOP === "1";
let demoBackground = { enabled: true, model: false };
let demoSound = true;
const DEMO_DOWNLOADS = mkdtempSync(join(tmpdir(), "alden-demo-downloads-"));
const preparedAt = new Date(Date.now() - 25 * 60_000).toISOString();
// ALDEN_DEMO_NO_MODEL=1 starts with no model, to show "Set up a model". Its key test and Ollama download are pretend:
// a key ending in "bad" is refused, one ending in "offline" can't be checked, and Ollama "downloads" in a few seconds.
let demoModel = process.env.ALDEN_DEMO_NO_MODEL !== "1";
// What the queue last showed, so reactions find their row as the real API does.
let lastRows: ReturnType<typeof queueRows> = [];

const api: UiApi = {
  session: async () => ({
    version: "demo",
    cwd: ROOT,
    repo: { root: ROOT, repos: [DEMO_REPO] },
    // ALDEN_DEMO_SIGNED_OUT=1 shows the sign-in card, as if GitHub had rejected the saved sign-in.
    user: process.env.ALDEN_DEMO_SIGNED_OUT === "1" ? { error: "rejected" } : { login: "you", source: "demo" },
    signIn: { source: "alden" as const, gitHubCli: true },
    // ALDEN_DEMO_SCOPED=1 shows a queue scoped to some orgs on this machine.
    queueScope:
      process.env.ALDEN_DEMO_SCOPED === "1"
        ? { orgs: ["django", "vercel"], repos: [], ignore: ["grafana"] }
        : { orgs: [], repos: [], ignore: [] },
    cli: { state: "missing" as const, bundled: "/Applications/Alden.app/Contents/MacOS/alden" },
    model: {
      provider: "anthropic",
      name: "sonnet",
      id: "claude-sonnet-5",
      effort: "medium",
      supportsEffort: true,
      available: demoModel,
      ...(demoModel ? {} : { reason: "No Anthropic API key found, so only the checks ran." }),
    },
    aliases: { sonnet: "claude-sonnet-5", opus: "claude-opus-5", haiku: "claude-haiku-4-5", fable: "claude-fable-5-1" },
    efforts: ["low", "medium", "high", "xhigh", "max"],
    budget: { perReviewUsd: 0.5, dailyUsd: 10, spentToday: 0.37 },
    desktop: DEMO_DESKTOP,
    background: demoBackground,
    notifications: { sound: demoSound },
  }),
  prepareNext: async () => ({ prepared: null, reason: "demo" }),
  setModelKey: async (key) => {
    demoModel = key !== null;
    return { key: demoModel ? { source: "alden", where: "the key you stored with `alden auth model`" } : null };
  },
  // Saves to ALDEN_HOME's config.toml: run the demo with ALDEN_HOME set to a temporary folder to keep yours as it is.
  ranking: createRankingApi({
    cwd: process.cwd(),
    desktop: DEMO_DESKTOP,
    queue: async () => ({ viewer: "you", fetchedAt: new Date().toISOString(), pullRequests: facts, warnings: [] }),
    learning: async (queue) => {
      const learned = new Map<string, Learning>();
      for (const pr of queue.pullRequests) learned.set(pr.repo.toLowerCase(), await learningFor(pr.repo));
      return (repo) => learned.get(repo.toLowerCase());
    },
  }),
  modelSetup: {
    state: async () => ({
      current: { provider: "anthropic", model: "claude-sonnet-5", available: demoModel, reason: null },
      key: null,
      ollama: {
        reachable: true,
        url: "http://localhost:11434",
        version: "0.12.3",
        models: [{ name: "llama3.2:3b", sizeBytes: 2_019_393_189, parameterSize: "3.2B" }],
        reason: null,
      },
      memoryGb: 24,
      recommendation: {
        model: "qwen2.5-coder:14b",
        download: "9 GB",
        why: "fits 16 to 32 GB of memory",
        installed: false,
      },
    }),
    testKey: async (key, untested) => {
      await sleep(900);
      if (key.endsWith("bad")) return { ok: false, reason: "invalid", message: "Anthropic didn't accept that key." };
      if (key.endsWith("offline") && !untested) {
        return { ok: false, reason: "network", message: "Couldn't reach api.anthropic.com to check the key." };
      }
      demoModel = true;
      return { ok: true, key: { source: "alden", where: "the key you stored with `alden auth model`" } };
    },
    useLocal: async (model, onEvent, signal) => {
      onEvent({ type: "progress", status: "pulling manifest", completed: null, total: null });
      for (let i = 1; i <= 20 && !signal.aborted; i++) {
        await sleep(250);
        onEvent({ type: "progress", status: "pulling ac3d1ba8aa77", completed: i * 0.45e9, total: 9e9 });
      }
      if (signal.aborted) return;
      demoModel = true;
      onEvent({ type: "done", model, baseUrl: "http://localhost:11434/v1" });
    },
    open: async (page) => ({ opened: page }),
  },
  startSignIn: async () => ({
    state: "waiting",
    userCode: "DEMO-1234",
    verificationUri: "https://github.com/login/device",
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
  }),
  signInStatus: async () => ({ state: "idle" }),
  openSignIn: async () => ({ state: "idle" }),
  useGitHubCli: async () => ({ login: "you" }),
  cliStatus: async () => ({ state: "missing", bundled: "/Applications/Alden.app/Contents/MacOS/alden" }),
  installCli: async () => ({ state: "installed", path: "/usr/local/bin/alden" }),
  prepared: async (pr) => {
    if (!DEMO_DESKTOP) return pr ? null : [];
    if (pr === undefined) return [{ pr: "django/django#19057", updatedAt: "", at: preparedAt }];
    if (pr.toLowerCase() !== "django/django#19057") return null;
    return { briefing: briefingFor("django/django", 19057, await learningFor("django/django"), false), at: preparedAt };
  },
  queue: async () => {
    const learned = new Map<string, Learning>();
    for (const repo of new Set(facts.map((f) => f.repo.toLowerCase()))) learned.set(repo, await learningFor(repo));
    // Read afresh, so what Settings → Ranking saves (to ALDEN_HOME's config) shows on the next refresh.
    const { queue: queueConfig } = await loadConfig();
    const ranked = rankQueue(
      { viewer: "you", fetchedAt: new Date().toISOString(), pullRequests: facts, warnings: [] },
      queueConfig,
      Date.now(),
      (repo) => learned.get(repo.toLowerCase()),
    );
    lastRows = queueRows(ranked, queueConfig);
    return ranked;
  },
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
    return briefingFor(ref[1], Number(ref[2]), await learningFor(ref[1]), request.llm !== false);
  },
  spend: async () => ({
    today: new Date().toISOString().slice(0, 10),
    spentToday: 0.37,
    dailyUsd: 10,
    perReviewUsd: 0.5,
    byModel: [{ model: "claude-sonnet-5", calls: 8, usd: 0.37 }],
    lastDays: [],
    todayByPurpose: [
      { purpose: "vercel/next.js#99367", usd: 0.12 },
      { purpose: "django/django#19057", usd: 0.11 },
      { purpose: "grafana/grafana#133736", usd: 0.09 },
      { purpose: "local changes", usd: 0.05 },
    ],
  }),
  addFeedback: (input) => feedback.add(input),
  feedbackSummary: () => feedback.summary(),
  memory: (repo) => memoryOf(repo),
  addMemory: async ({ repo, text }) => {
    addNote(store, repo ?? DEMO_REPO, text);
    return memoryOf(repo);
  },
  forgetMemory: async ({ repo, id }) => {
    await forget(store, repo ?? DEMO_REPO, id);
    return memoryOf(repo);
  },
  changeMemory: async (change) => {
    const repo = change.repo ?? DEMO_REPO;
    if (change.action === "edit") await editNote(store, repo, change.id, change.text);
    if (change.action === "restore") restore(store, repo, change.id);
    if (change.action === "learning") setLearning(store, repo, change.on);
    if (change.action === "forget-all") await forgetAll(store, repo);
    return memoryOf(repo);
  },
  memoryRepos: () => memoryRepos(store),
  react: async ({ pr, reaction }) => {
    const row = lastRows.find((r) => `${r.repo}#${r.number}`.toLowerCase() === pr.toLowerCase());
    if (!row) throw new Error(`${pr} isn't in the demo queue.`);
    recordReaction(store, row, reaction, row.updatedAt ?? new Date().toISOString());
    return { pr, reaction };
  },
  exportFeedback: async () => redactFeedback(await feedback.events()),
  openLink: async (url) => ({ opened: url }),
  saveFeedback: async () => {
    const events = redactFeedback(await feedback.events());
    const saved = await saveToDownloads("alden-feedback.json", JSON.stringify(events, null, 2), DEMO_DOWNLOADS);
    return { ...saved, events: events.length };
  },
  // The demo never sends anything: it remembers the answer for this run only.
  telemetry: async () => ({ consent: demoConsent, blocked: null }),
  setTelemetry: async (on) => {
    demoConsent = on ? "on" : "off";
    return { consent: demoConsent, blocked: null };
  },
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
  setConfig: async (key, value) => {
    if (key === "background.enabled") demoBackground = { ...demoBackground, enabled: value === "true" };
    if (key === "background.model") demoBackground = { ...demoBackground, model: value === "true" };
    if (key === "notifications.sound") demoSound = value === "true";
    return { path: "(demo)", config };
  },
  // The Diff tab, from the recorded diffs; local changes are this repo's own.
  diff: async (pr) => {
    if (pr === undefined) return localDiffView(ROOT);
    const ref = /^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:#|\/pull\/)(\d+)$/.exec(pr);
    const match = recorded.find(
      ({ raw }) => raw.repository.nameWithOwner === ref?.[1] && raw.number === Number(ref?.[2]),
    );
    if (!match) throw new Error("Demo mode has diffs for the recorded PRs only (owner/repo#123).");
    const files = (
      JSON.parse(readFileSync(join(FIXTURES, "diffs", `${match.name}-${match.raw.number}.json`), "utf8")) as Parameters<
        typeof fromRestFile
      >[0][]
    ).map(fromRestFile);
    return toDiffView(`demo-${match.raw.number}`, files);
  },
  // The desktop app's Save as Markdown, into a throwaway folder rather than your Downloads.
  saveBriefing: async (briefing) =>
    saveToDownloads(briefingFileName(briefing), briefingMarkdown(briefing), DEMO_DOWNLOADS),
};

const ui = await startUiServer({ api, staticDir: join(ROOT, "packages/ui/dist"), port, token: "demo" });
console.log(`Alden demo UI at ${ui.url}  (build the UI first: pnpm --filter @alden/ui build)`);
