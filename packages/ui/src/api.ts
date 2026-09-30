import type { Briefing, RankedQueue } from "@alden/schema";

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
}

export interface SpendReport {
  today: string;
  spentToday: number;
  dailyUsd: number;
  perReviewUsd: number;
  byModel: { model: string; calls: number; usd: number | null }[];
  lastDays: { day: string; calls: number; usd: number; unpriced: number }[];
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
