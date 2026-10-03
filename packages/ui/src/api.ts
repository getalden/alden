import type { Briefing, FeedbackInput, FeedbackSummary, MemoryItem, RankedQueue, RepoStats } from "@alden/schema";

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
  };
  aliases: Record<string, string>;
  efforts: string[];
  budget: { perReviewUsd: number; dailyUsd: number; spentToday: number };
  /** Running inside the desktop app, which can prepare briefings while you're away. */
  desktop?: boolean;
  /** Where the GitHub sign-in comes from, and whether the GitHub CLI's is there to switch to. */
  signIn?: { source: "env" | "alden" | "gh" | null; gitHubCli: boolean };
  /** The desktop app's `alden` command. */
  cli?: CliStatus;
  background?: { enabled: boolean; model: boolean };
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

  queue = (refresh = false) => this.request<RankedQueue>(`/api/queue${refresh ? "?refresh=1" : ""}`);

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

  startSignIn = () => this.request<SignInState>("/api/auth/device", { method: "POST" });

  signInStatus = () => this.request<SignInState>("/api/auth/device");

  openSignIn = () => this.request<SignInState>("/api/auth/device/open", { method: "POST" });

  useGitHubCli = () => this.request<{ login: string } | { error: string }>("/api/auth/gh", { method: "POST" });

  cliStatus = () => this.request<CliStatus>("/api/cli");

  installCli = () => this.request<CliInstall>("/api/cli/install", { method: "POST" });

  /** PRs ("owner/repo#12") with a briefing ready from the background. */
  preparedList = () => this.request<{ pr: string; at: string }[]>("/api/prepared");

  /** That PR's background briefing, or null when there's none or the PR has changed since. */
  prepared = (pr: string) => this.request<Prepared | null>(`/api/prepared?pr=${encodeURIComponent(pr)}`);

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

  /** `null` removes the setting, so its default applies again. */
  setConfig = (key: string, value: string | null) =>
    this.request<unknown>("/api/config", { method: "PUT", body: JSON.stringify({ key, value }) });

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
