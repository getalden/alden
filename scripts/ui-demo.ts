/**
 * The web UI over recorded public PRs instead of your GitHub account: `pnpm ui:demo [--port 4319]`.
 *
 * For working on the UI and taking screenshots. Nothing is fetched and no model is called: the queue is the recorded
 * PRs (with their wait times moved to recent hours so the ranking looks lived-in), reviews are the offline
 * deterministic briefings, and one PR gets an invented model section so its styling can be seen. A throwaway
 * database is seeded with feedback, opens and notes for vercel/next.js, so learning and the Memory view have
 * something to show, and with a few draft comments on cli/cli#10513, so the Comments drawer does too. Nothing
 * is ever sent: Send review says so instead.
 *
 * Settings → Ranking saves to ALDEN_HOME's config.toml, and the queue reads it: set ALDEN_HOME to a temporary folder
 * (as `pnpm screenshots` does) to keep your own as it is.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefingFileName, briefingMarkdown } from "../packages/cli/src/render/markdown.js";
import { saveToDownloads } from "../packages/cli/src/ui/api.js";
import { createRankingApi } from "../packages/cli/src/ui/rank.js";
import { ApiError, startUiServer, type UiApi } from "../packages/cli/src/ui/server.js";
import {
  addActiveTime,
  addNote,
  buildBriefing,
  closeReviewSession,
  draftsAtHead,
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
  openReviewSession,
  openStore,
  placeOrLink,
  prFeatures,
  prName,
  publicDraft,
  queueRows,
  type RawPullRequest,
  ReviewDrafts,
  rankQueue,
  recordReaction,
  recordSeen,
  redactFeedback,
  restore,
  reviewTimeStats,
  type StatsPullRequest,
  scopeNote,
  setLearning,
  summarizeStats,
  toDiffView,
  toFacts,
  unaddressedPlaces,
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

/** A recorded PR's changed files, as GitHub sent them. */
const filesOf = (name: string, number: number) =>
  (
    JSON.parse(readFileSync(join(FIXTURES, "diffs", `${name}-${number}.json`), "utf8")) as Parameters<
      typeof fromRestFile
    >[0][]
  ).map(fromRestFile);

/** A made-up head commit per PR, the same every run, so drafts, the diff and the briefing agree on it. */
const headOf = (repo: string, number: number) => createHash("sha1").update(`${repo}#${number}`).digest("hex");

const PR_REF = /^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:#|\/pull\/)(\d+)$/;

/** A recorded PR from "owner/repo#12" or its URL: its name as drafts name it, its head and its files. */
function recordedPr(ref: string) {
  const parts = PR_REF.exec(ref);
  const match = recorded.find(
    ({ raw }) =>
      raw.repository.nameWithOwner.toLowerCase() === parts?.[1]?.toLowerCase() && raw.number === Number(parts?.[2]),
  );
  if (!match) throw new ApiError(400, "Demo mode has the recorded PRs only (owner/repo#123).");
  const { nameWithOwner: repo } = match.raw.repository;
  const { number } = match.raw;
  return {
    repo,
    number,
    name: prName(repo, number),
    headSha: headOf(repo, number),
    files: filesOf(match.name, number),
  };
}

function briefingFor(repo: string, number: number, learning?: Learning, withModel = true): Briefing {
  const match = recorded.find(({ raw }) => raw.repository.nameWithOwner === repo && raw.number === number);
  if (!match) throw new Error(`${repo}#${number} isn't one of the recorded PRs.`);
  const files = filesOf(match.name, number);
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
      headSha: headOf(pr.repo, pr.number),
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

// Time to review: a few weeks of pretend reviews in the throwaway database, so Stats has something to show.
{
  const DAY = 86_400_000;
  const MIN = 60_000;
  const reviews: [daysAgo: number, activeMin: number, wallMin: number, model: boolean][] = [
    [4, 9, 35, true],
    [5, 14, 180, true],
    [6, 6, 22, false],
    [8, 11, 95, true],
    [9, 4, 18, false],
    [11, 17, 300, true],
    [13, 8, 40, false],
    [16, 12, 70, true],
    [19, 22, 1500, false],
    [23, 7, 25, true],
    [27, 10, 60, false],
    [40, 15, 130, true],
  ];
  reviews.forEach(([daysAgo, active, wall, model], i) => {
    const pr = `demo/past#${i + 1}`;
    const opened = new Date(Date.now() - daysAgo * DAY);
    openReviewSession(store, { pr, surface: "ui", model }, opened);
    // The UI reports a few seconds at a time; here, at most five minutes a report, as the server takes.
    for (let left = active; left > 0; left -= 5) addActiveTime(store, pr, Math.min(left, 5) * MIN, opened);
    closeReviewSession(store, { pr, verdict: "APPROVE", comments: i % 3 }, new Date(opened.getTime() + wall * MIN));
  });
}
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

// A review in progress on one PR, for the Comments drawer: a comment on a line, a suggested change on a range, a
// linked note on code outside the diff, and a draft Claude Code added.
const drafts = new ReviewDrafts(store);
const DRAFTS_PR = "cli/cli#10513";
{
  const pr = recordedPr(DRAFTS_PR);
  const draft = (
    at: { path: string; line?: number; startLine?: number },
    body: string,
    options: { suggestion?: string; source?: "you" | "claude" | "alden" } = {},
  ) => {
    const spot = placeOrLink(pr.files, at.path, at.line, "RIGHT", at.startLine);
    if ("problem" in spot) throw new Error(spot.problem);
    drafts.add({
      pr: pr.name,
      headSha: pr.headSha,
      body,
      source: options.source ?? "you",
      ...spot,
      ...(options.suggestion !== undefined ? { suggestion: options.suggestion } : {}),
    });
  };
  if (drafts.list(pr.name).length === 0) {
    draft(
      { path: "git/client.go", line: 470 },
      "What does `gh pr create` do when this errors? A test with an unknown value would show it.",
    );
    draft(
      { path: "git/client.go", startLine: 466, line: 470 },
      "Returning early reads a little easier, and %q shows an empty value:",
      {
        suggestion:
          '\tif _, ok := validPushDefaults[s]; !ok {\n\t\treturn "", fmt.Errorf("unknown push.default value: %q", s)\n\t}\n\treturn PushDefault(s), nil',
      },
    );
    draft(
      { path: "git/client.go", line: 405 },
      "Not for this PR: the other config readers in this file could get the same parse-and-check treatment in a follow-up.",
    );
    draft(
      { path: "git/client.go", line: 479 },
      "PushDefault now returns an error for a value it doesn't know, where before it passed the string through. The new tests cover the known values but not an unknown one.",
      { source: "claude" },
    );
    // Alden's drafts: one suggested (Keep, Edit, Drop), one you kept, which looks like yours now.
    draft(
      { path: "git/client.go", line: 456 },
      "An unknown push.default now fails the whole command. Could this fall back to simple with a warning, as git does?",
      { source: "alden" },
    );
    draft(
      { path: "git/client.go", line: 543 },
      "ParseRemoteTrackingRef splits on every slash, so a branch named feature/x won't parse. SplitN with 4 keeps it whole.",
      { source: "alden" },
    );
    const kept = drafts.list(pr.name).find((d) => d.line === 543);
    if (kept) {
      store.run(
        "UPDATE drafts SET source = 'you', drafted = ? WHERE id = ?",
        JSON.stringify({ checkId: "model", title: "Branch names with slashes" }),
        kept.id,
      );
    }
    // Two drafts written against an older head whose lines have changed since: one Alden can move, one you place.
    const outdated = (
      line: number,
      startLine: number | undefined,
      text: string,
      body: string,
      source: "you" | "claude",
    ) => {
      const spot = placeOrLink(pr.files, "git/client.go", line, "RIGHT", startLine);
      if (!("place" in spot)) throw new Error("not on the diff");
      const lines = [...(spot.place.lines ?? [])];
      lines[lines.length - 1] = text;
      drafts.add({
        pr: pr.name,
        headSha: "3f2a91c0d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9",
        body,
        source,
        place: { ...spot.place, anchor: { ...spot.place.anchor, text }, lines },
      });
    };
    outdated(
      486,
      485,
      '\t\treturn "simple", nil',
      "Return the PushDefaultSimple constant here, so the default is named in one place.",
      "claude",
    );
    outdated(
      488,
      undefined,
      '\tlog.Printf("push.default unset for %s", branch)',
      "Is logging here useful, or noise for everyone without push.default set?",
      "you",
    );
  }
}

/** The conversation on the demo's PR with drafts, for the drawer's Conversation tab. Made up; nothing is fetched. */
const demoThreads = (pr: string) => {
  const at = (h: number) => new Date(Date.now() - h * hour).toISOString();
  const comment = (author: string, body: string, hoursAgo: number, isYou = false) => ({
    id: `C_${author}_${hoursAgo}`,
    databaseId: hoursAgo,
    author: isYou ? "you" : author,
    isYou,
    body,
    createdAt: at(hoursAgo),
    url: "https://github.com/cli/cli/pull/10513",
  });
  const thread = (id: string, line: number, extra: Record<string, unknown>) => ({
    id,
    path: "git/client.go",
    line,
    startLine: null,
    originalLine: line,
    side: "RIGHT" as const,
    isResolved: false,
    isOutdated: false,
    startedByYou: false,
    viewerCanReply: true,
    viewerCanResolve: true,
    comments: [],
    ...extra,
  });
  return {
    schemaVersion: 1 as const,
    pr,
    headSha: recordedPr(pr).headSha,
    viewer: "you",
    threads:
      pr.toLowerCase() === DRAFTS_PR
        ? [
            thread("T_yours", 477, {
              startedByYou: true,
              comments: [
                comment("you", "Should Config errors other than a missing key reach the caller?", 26, true),
                comment("babakks", "Good call, they do now. Does this read better?", 2),
              ],
            }),
            thread("T_open", 538, {
              comments: [comment("williammartin", "Should PushRevision say which branch it couldn't resolve?", 5)],
            }),
            thread("T_done", 445, {
              startedByYou: true,
              isResolved: true,
              comments: [comment("you", "Name this PushDefault?", 30, true)],
            }),
          ]
        : [],
  };
};

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
let demoLearnFromReviews = true;
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
    learning: { fromReviews: demoLearnFromReviews },
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
    // Your turn: the last Needs you PR, as if you'd reviewed it and Ana answered since (it leaves the queue for it).
    const turn = ranked.needsYou.at(-1);
    const shown = turn ? { ...ranked, needsYou: ranked.needsYou.slice(0, -1) } : ranked;
    lastRows = queueRows(shown, queueConfig);
    if (!turn) return shown;
    const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const news = { text: "Ana replied to 2 of your comments · 1 resolved", at, replies: 2, resolved: 1, outdated: 0 };
    return {
      ...shown,
      yourTurn: [
        {
          pr: `${turn.pr.repo}#${turn.pr.number}`,
          repo: turn.pr.repo,
          number: turn.pr.number,
          title: turn.pr.title,
          url: turn.pr.url,
          news: { ...news, events: ["demo-turn"] },
        },
      ],
    };
  },
  review: async (request, onStage) => {
    const ref = PR_REF.exec(request.pr ?? "");
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
    const briefing = briefingFor(ref[1], Number(ref[2]), await learningFor(ref[1]), request.llm !== false);
    drafts.rememberBriefing(briefing);
    openReviewSession(store, { pr: `${ref[1]}#${ref[2]}`, surface: "ui", model: request.llm !== false });
    return briefing;
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
    if (change.action === "exclude" || change.action === "include") {
      await scopeNote(store, repo, change.id, change.path, change.action);
    }
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
    if (key === "learning.fromReviews") demoLearnFromReviews = value !== "false";
    return { path: "(demo)", config };
  },
  // The Diff tab, from the recorded diffs; local changes are this repo's own.
  diff: async (pr) => {
    if (pr === undefined) return localDiffView(ROOT);
    const { headSha, files } = recordedPr(pr);
    return toDiffView(headSha, files);
  },
  // Every briefing is current, except Laravel's #60005, whose base has moved on, to show Re-brief.
  freshness: async (target) =>
    target.kind === "pr" && target.repo === "laravel/framework" && target.number === 60005
      ? { state: "base_moved", baseRef: target.baseRef ?? "main", commits: 4 }
      : { state: "fresh" },
  // No clones in the demo: PR briefings run on the diff alone.
  clone: async (repo) => ({ repo, path: null, how: null }),
  // Comments, kept in the throwaway database. A comment outside a PR's diff becomes a linked note, as in Alden.
  drafts: async (pr) => {
    const { name, headSha, files } = recordedPr(pr);
    drafts.follow(name, headSha, files);
    const list = drafts.list(name);
    return {
      drafts: draftsAtHead(list, headSha, files),
      unaddressed: unaddressedPlaces(drafts.briefed(name)?.places ?? [], list),
    };
  },
  addDraft: async (input, source = "you") => {
    const pr = recordedPr(input.pr);
    let spot: ReturnType<typeof placeOrLink> | undefined;
    if (input.path !== undefined) {
      spot = placeOrLink(pr.files, input.path, input.line, input.side ?? "RIGHT", input.startLine);
      if ("problem" in spot) throw new ApiError(422, spot.problem);
    }
    try {
      return publicDraft(
        drafts.add({
          pr: pr.name,
          headSha: pr.headSha,
          body: input.body,
          source,
          ...spot,
          ...(input.suggestion !== undefined ? { suggestion: input.suggestion } : {}),
        }),
      );
    } catch (error) {
      throw new ApiError(400, (error as Error).message);
    }
  },
  editDraft: async (id, change) => {
    const draft = drafts.get(id);
    if (!draft) throw new ApiError(404, `No draft ${id}.`);
    let place: Parameters<ReviewDrafts["edit"]>[1]["place"];
    let linkTo: Parameters<ReviewDrafts["edit"]>[1]["linkTo"];
    if (change.path !== undefined) {
      const pr = recordedPr(draft.pr);
      const spot = placeOrLink(pr.files, change.path, change.line, change.side ?? "RIGHT", change.startLine);
      if ("problem" in spot) throw new ApiError(422, spot.problem);
      if ("place" in spot) place = { ...spot.place, headSha: pr.headSha };
      else linkTo = { ...spot.linkTo, headSha: pr.headSha };
    }
    try {
      const edited = drafts.edit(id, {
        ...(change.body !== undefined ? { body: change.body } : {}),
        ...(change.suggestion !== undefined ? { suggestion: change.suggestion } : {}),
        ...(place ? { place } : {}),
        ...(linkTo ? { linkTo } : {}),
      });
      if (!edited) throw new ApiError(404, `No draft ${id}.`);
      return publicDraft(edited);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, (error as Error).message);
    }
  },
  deleteDraft: async (id) => {
    if (!drafts.delete(id)) throw new ApiError(404, `No draft ${id}.`);
    return { ok: true };
  },
  // Drafting with Alden, with no model: stand-in words, so the buttons and what they say can be seen.
  draftReview: async ({ pr }) => {
    const { name, headSha, files } = recordedPr(pr);
    const places = drafts.briefed(name)?.places ?? [];
    const made = places.slice(0, 2).map((place) => {
      const spot = place.anchor ? placeOrLink(files, place.anchor.path, place.anchor.line, "RIGHT") : undefined;
      return drafts.add({
        pr: name,
        headSha,
        source: "alden",
        body: `Demo: the model would write the comment for "${place.title}" here.`,
        ...(spot && !("problem" in spot) ? spot : {}),
      });
    });
    const asked = places.length;
    return { made: made.length, skipped: 0, asked, costUsd: null, drafts: made.map(publicDraft) };
  },
  suggestText: async ({ text }) => ({
    text: text?.trim()
      ? `${text.trim()} (Demo: the model would make this a clear comment.)`
      : "Demo: the model would write this comment from the code here.",
    costUsd: null,
  }),
  // The places you saw, kept in the throwaway database as Alden keeps them in yours.
  recordSeen: async ({ pr, headSha, places }) => {
    if (!demoLearnFromReviews) return { recorded: 0 };
    return { recorded: places.filter((place) => recordSeen(store, { pr, headSha, ...place })).length };
  },
  reportActive: async ({ pr, activeMs }) => ({ counted: addActiveTime(store, pr, activeMs) }),
  reviewTime: async () => reviewTimeStats(store),
  threads: async (pr) => demoThreads(recordedPr(pr).name),
  sendReview: async () => {
    throw new ApiError(409, "This is Alden's demo: it never sends anything to GitHub. Your drafts are kept.");
  },
  // The desktop app's Save as Markdown, into a throwaway folder rather than your Downloads.
  saveBriefing: async (briefing) =>
    saveToDownloads(briefingFileName(briefing), briefingMarkdown(briefing), DEMO_DOWNLOADS),
};

const ui = await startUiServer({ api, staticDir: join(ROOT, "packages/ui/dist"), port, token: "demo" });
console.log(`Alden demo UI at ${ui.url}  (build the UI first: pnpm --filter @alden/ui build)`);
