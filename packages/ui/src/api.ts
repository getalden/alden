import type {
  Briefing,
  BriefingFreshness,
  BriefingTarget,
  FeedbackInput,
  FeedbackSummary,
  KeyTestResult,
  LocalSetupEvent,
  MemoryItem,
  ModelSetupState,
  PrDiff,
  RankedQueue,
  RankingState,
  RankPreview,
  RankRule,
  RankWeight,
  RepoStats,
} from "@alden/schema";
import type { DraftsResponse, NewDraft, ReviewDraft, ReviewEvent as ReviewVerdict, SendReviewResult } from "./drafts";

export interface Memory {
  repo: string;
  items: MemoryItem[];
  paused: boolean;
  /** Where it's kept, e.g. ~/.alden/alden.db. */
  path: string;
}

export interface MemoryRepo {
  repo: string;
  items: number;
  /** ISO time of the last change; "" when nothing is known yet. */
  lastChange: string;
  paused: boolean;
}

/** Anonymous usage stats: on, off, or not asked yet; `blocked` says what forces them off (DO_NOT_TRACK, CI). */
export interface Telemetry {
  consent: "on" | "off" | "unset";
  blocked: string | null;
}

export type MemoryChange =
  | { action: "edit"; id: string; text: string }
  | { action: "restore"; id: string }
  | { action: "learning"; on: boolean }
  | { action: "forget-all" };

const TOKEN_KEY = "alden.token";

/**
 * The session token from `alden ui`'s link. It arrives in the URL fragment; keep it for this tab only and take it
 * out of the address bar, so it isn't bookmarked or shared by accident.
 */
export function takeToken(win: Window = window): string | undefined {
  const match = /(?:^#|&)t=([\w-]+)/.exec(win.location.hash);
  if (match?.[1]) {
    try {
      win.sessionStorage.setItem(TOKEN_KEY, match[1]);
    } catch {
      // Storage can be blocked; the token then lives only as long as this page.
    }
    win.history.replaceState(null, "", win.location.pathname + win.location.search);
    return match[1];
  }
  try {
    return win.sessionStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the desktop app just restarted Alden in a folder you chose (it adds `folder=chosen` to the link's fragment).
 * Read before `takeToken`, which clears the fragment.
 */
export function takeChosenFolder(win: Window = window): boolean {
  return /(?:^#|&)folder=chosen(?:&|$)/.test(win.location.hash);
}

export interface Session {
  version: string;
  cwd: string;
  repo: { root: string; repos: string[] } | null;
  user: { login: string; source: string } | { error: string } | null;
  model: {
    provider: string;
    name: string;
    id: string;
    effort: string | null;
    supportsEffort: boolean;
    available: boolean;
    reason?: string;
    /** Where the Anthropic key comes from ("env", "alden" for the stored key, "ant"); never the key itself. */
    key?: { source: "env" | "alden" | "ant"; where: string } | null;
  };
  aliases: Record<string, string>;
  efforts: string[];
  budget: { perReviewUsd: number; dailyUsd: number; spentToday: number };
  /** Running inside the desktop app, which can prepare briefings while you're away. */
  desktop?: boolean;
  /** Where the GitHub sign-in comes from, and whether the GitHub CLI's is there to switch to. */
  signIn?: { source: "env" | "alden" | "gh" | null; gitHubCli: boolean; problem?: SignInProblem };
  /** The desktop app's `alden` command. */
  cli?: CliStatus;
  /** How many places "Needs your eyes" holds (`review.eyes`). */
  eyes?: number;
  /** What this machine's queue covers (queue.orgs, queue.repos, queue.ignore); empty lists mean everywhere. */
  queueScope?: { orgs: string[]; repos: string[]; ignore: string[] };
  background?: { enabled: boolean; model: boolean };
  /** Whether the desktop app's "Briefing ready" notification plays a sound (`notifications.sound`). */
  notifications?: { sound: boolean };
}

/** Why there's no GitHub sign-in: the keychain refused (an unsigned build of the app), or there's none anywhere. */
export type SignInProblem = { kind: "keychain"; detail: string } | { kind: "none" };

/** The clone a repo's callers come from, and how Alden found it. */
export interface CloneInfo {
  repo: string;
  path: string | null;
  how: "here" | "remembered" | "folders" | null;
}

export type SignInState =
  | { state: "idle" }
  | { state: "waiting"; userCode: string; verificationUri: string; expiresAt: string }
  | { state: "done"; login: string }
  | { state: "failed"; message: string };

export type CliStatus =
  | { state: "unavailable" }
  | { state: "installed"; path: string; ours: boolean }
  | { state: "missing"; bundled: string };

export type CliInstall =
  | { state: "installed"; path: string }
  | { state: "exists"; path: string }
  | { state: "cancelled" }
  | { state: "failed"; message: string };

/** A briefing the desktop app made in the background, and when. */
export interface Prepared {
  briefing: Briefing;
  at: string;
}

export interface SpendReport {
  today: string;
  spentToday: number;
  dailyUsd: number;
  perReviewUsd: number;
  byModel: { model: string; calls: number; usd: number | null }[];
  lastDays: { day: string; calls: number; usd: number; unpriced: number }[];
  todayByPurpose?: { purpose: string; usd: number }[];
}

export interface ReviewRequest {
  pr?: string;
  llm?: boolean;
  graph?: boolean;
  model?: string;
  effort?: string;
}

export type ReviewEvent =
  | { type: "stage"; stage: "fetch" | "graph" | "checks" | "model"; label: string }
  | { type: "briefing"; briefing: Briefing }
  | { type: "error"; message: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The local API. Only ever relative URLs, so it works wherever the UI is served from, including a desktop shell. */
export class Api {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetcher(path, {
      ...init,
      headers: { "X-Alden-Token": this.token, "Content-Type": "application/json", ...init.headers },
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, body.error ?? `The request failed (${res.status}).`);
    return body as T;
  }

  session = () => this.request<Session>("/api/session");

  /** `cached`: the last queue at once, up to a day old (its `fetchedAt` says how old); otherwise a current one. */
  queue = (options: { refresh?: boolean; cached?: boolean } = {}) =>
    this.request<RankedQueue>(`/api/queue${options.refresh ? "?refresh=1" : options.cached ? "?cached=1" : ""}`);

  spend = () => this.request<SpendReport>("/api/spend");

  addFeedback = (input: FeedbackInput) =>
    this.request<unknown>("/api/feedback", { method: "POST", body: JSON.stringify(input) });

  feedbackSummary = () => this.request<FeedbackSummary>("/api/feedback");

  memory = (repo?: string) => this.request<Memory>(`/api/memory${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`);

  addMemory = (text: string, repo?: string) =>
    this.request<Memory>("/api/memory", { method: "POST", body: JSON.stringify({ text, ...(repo ? { repo } : {}) }) });

  memoryRepos = () => this.request<MemoryRepo[]>("/api/memory/repos");

  changeMemory = (change: MemoryChange, repo?: string) =>
    this.request<Memory>("/api/memory/change", {
      method: "POST",
      body: JSON.stringify({ ...change, ...(repo ? { repo } : {}) }),
    });

  react = (pr: string, reaction: "up" | "down" | "dismiss" | "clear") =>
    this.request<unknown>("/api/reaction", { method: "POST", body: JSON.stringify({ pr, reaction }) });

  exportFeedback = () => this.request<unknown[]>("/api/feedback/export");
  openLink = (url: string) =>
    this.request<{ opened: string }>("/api/open", { method: "POST", body: JSON.stringify({ url }) });
  saveFeedback = () =>
    this.request<{ path: string; shown: string; events: number }>("/api/feedback/save", { method: "POST" });

  /** A briefing as a Markdown document to share (the same as `alden review --markdown`), and the file to save it as. */
  briefingMarkdown = (briefing: Briefing) =>
    this.request<{ markdown: string; fileName: string }>("/api/briefing/markdown", {
      method: "POST",
      body: JSON.stringify({ briefing }),
    });

  /** The desktop app's Save as Markdown: the server writes it to Downloads, since the window can't download files. */
  saveBriefing = (briefing: Briefing) =>
    this.request<{ path: string; shown: string }>("/api/briefing/save", {
      method: "POST",
      body: JSON.stringify({ briefing }),
    });

  startSignIn = () => this.request<SignInState>("/api/auth/device", { method: "POST" });

  signInStatus = () => this.request<SignInState>("/api/auth/device");

  openSignIn = () => this.request<SignInState>("/api/auth/device/open", { method: "POST" });

  useGitHubCli = () => this.request<{ login: string } | { error: string }>("/api/auth/gh", { method: "POST" });

  /** Stores the Anthropic API key (null removes it). The answer says where the key comes from, never the key. */
  setModelKey = (key: string | null) =>
    this.request<{ key: Session["model"]["key"] }>("/api/model-key", { method: "PUT", body: JSON.stringify({ key }) });

  /** What "Set up a model" offers: any key Alden finds, Ollama and its models, the local model for this machine. */
  modelSetup = () => this.request<ModelSetupState>("/api/model-setup");

  /** Tests the key with one tiny request and stores it if it works (`untested`: stores it without). Never echoed. */
  testModelKey = (key: string, untested = false) =>
    this.request<KeyTestResult>("/api/model-setup/test-key", {
      method: "POST",
      body: JSON.stringify({ key, ...(untested ? { untested: true } : {}) }),
    });

  /** Opens one of the setup step's pages in the default browser, from the server (the desktop window can't). */
  openSetupPage = (page: SetupPage) =>
    this.request<{ opened: string }>("/api/model-setup/open", { method: "POST", body: JSON.stringify({ page }) });

  /** Pulls a local model if Ollama doesn't have it, then makes it the model; `onEvent` hears the download's progress. */
  async setUpLocalModel(
    model: string,
    onEvent: (event: LocalSetupEvent) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const res = await this.fetcher("/api/model-setup/local", {
      method: "POST",
      headers: { "X-Alden-Token": this.token, "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      ...(signal ? { signal } : {}),
    });
    for await (const event of ndjson<LocalSetupEvent>(res)) {
      onEvent(event);
      if (event.type === "done") return event.model;
      if (event.type === "error") throw new ApiError(500, event.message);
    }
    throw new ApiError(500, "Setting up the local model ended without saying how it went.");
  }

  clone = (repo: string) => this.request<CloneInfo>(`/api/clone?repo=${encodeURIComponent(repo)}`);

  cliStatus = () => this.request<CliStatus>("/api/cli");

  installCli = () => this.request<CliInstall>("/api/cli/install", { method: "POST" });

  /** PRs ("owner/repo#12") with a briefing ready from the background. */
  preparedList = () => this.request<{ pr: string; at: string }[]>("/api/prepared");

  /** That PR's background briefing, or null when there's none or the PR has changed since. */
  prepared = (pr: string) => this.request<Prepared | null>(`/api/prepared?pr=${encodeURIComponent(pr)}`);

  /** Whether a briefing still matches its PR on GitHub: fresh, the PR has new commits, or its base has moved. */
  freshness = (target: BriefingTarget) =>
    this.request<BriefingFreshness>("/api/freshness", { method: "POST", body: JSON.stringify({ target }) });

  telemetry = () => this.request<Telemetry>("/api/telemetry");

  setTelemetry = (on: boolean) =>
    this.request<Telemetry>("/api/telemetry", { method: "PUT", body: JSON.stringify({ on }) });

  forgetMemory = (id: string, repo?: string) =>
    this.request<Memory>("/api/memory/forget", {
      method: "POST",
      body: JSON.stringify({ id, ...(repo ? { repo } : {}) }),
    });

  stats = (options: { repo: string; days: number; since?: string; refresh?: boolean }) => {
    const params = new URLSearchParams({ repo: options.repo, days: String(options.days) });
    if (options.since) params.set("since", options.since);
    if (options.refresh) params.set("refresh", "1");
    return this.request<RepoStats>(`/api/stats?${params}`);
  };

  /** Settings → Ranking: your weights, rules and how many top PRs to keep briefed (`[queue.rank]`). */
  rank = () => this.request<RankingState>("/api/rank");

  saveRank = (change: RankChange) =>
    this.request<RankingState>("/api/rank", { method: "PUT", body: JSON.stringify(change) });

  /** The current queue's top five ranked with these settings, unsaved, beside where each PR sits now. */
  previewRank = (settings: { weights: Partial<Record<RankWeight, number>>; rules: RankRule[] }) =>
    this.request<RankPreview>("/api/rank/preview", { method: "POST", body: JSON.stringify(settings) });

  /** `null` removes the setting, so its default applies again. */
  setConfig = (key: string, value: string | null) =>
    this.request<unknown>("/api/config", { method: "PUT", body: JSON.stringify({ key, value }) });

  /** A PR's drafts ("owner/repo#12"), and the places Alden flagged that have no comment near them. */
  drafts = (pr: string) => this.request<DraftsResponse>(`/api/drafts?pr=${encodeURIComponent(pr)}`);

  addDraft = (draft: NewDraft & { pr: string }) =>
    this.request<ReviewDraft>("/api/drafts", { method: "POST", body: JSON.stringify(draft) });

  editDraft = (id: string, body: string) =>
    this.request<ReviewDraft>(`/api/drafts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    });

  deleteDraft = (id: string) =>
    this.request<{ ok: true }>(`/api/drafts/${encodeURIComponent(id)}`, { method: "DELETE" });

  /**
   * The Diff tab: a PR's diff at its current head ("owner/repo#12"), or without one the local changes. The server keeps
   * a PR's diff per head commit, so asking again costs it one GitHub request.
   */
  diff = (pr?: string) => this.request<PrDiff>(`/api/diff${pr ? `?pr=${encodeURIComponent(pr)}` : ""}`);

  /** Posts every draft on the PR to GitHub as one review. Only ever called from the Send you confirmed. */
  sendReview = (review: { pr: string; event: ReviewVerdict; body?: string }) =>
    this.request<SendReviewResult>("/api/review/send", { method: "POST", body: JSON.stringify(review) });

  /** Runs a review, calling `onEvent` for each stage, then resolving with the briefing. */
  async review(request: ReviewRequest, onEvent: (event: ReviewEvent) => void, signal?: AbortSignal): Promise<Briefing> {
    const res = await this.fetcher("/api/review", {
      method: "POST",
      headers: { "X-Alden-Token": this.token, "Content-Type": "application/json" },
      body: JSON.stringify(request),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(res.status, body.error ?? `The review failed to start (${res.status}).`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      buffer += value ?? "";
      const lines = buffer.split("\n");
      buffer = done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as ReviewEvent;
        onEvent(event);
        if (event.type === "briefing") return event.briefing;
        if (event.type === "error") throw new ApiError(500, event.message);
      }
      if (done) throw new ApiError(500, "The review ended without a briefing.");
    }
  }
}

/** A change to how you rank: a weight of null (or 1) and an empty rule list go back to the defaults. */
export interface RankChange {
  weights?: Partial<Record<RankWeight, number | null>>;
  rules?: RankRule[];
  /** How many top PRs the desktop app keeps briefed; null for the default (3). */
  prepare?: number | null;
}

/** The pages the setup step links to: where to create an Anthropic key, Alden Cloud's waitlist, Ollama's download. */
export type SetupPage = "keys" | "cloud" | "ollama";

/** The lines of a newline-delimited JSON response, parsed; a failed request throws its error. */
async function* ndjson<T>(res: Response): AsyncGenerator<T> {
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `The request failed (${res.status}).`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += value ?? "";
    const lines = buffer.split("\n");
    buffer = done ? "" : (lines.pop() ?? "");
    for (const line of lines) if (line.trim()) yield JSON.parse(line) as T;
    if (done) return;
  }
}
