import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import type { ReviewStage } from "@alden/core";
import type { Briefing } from "@alden/schema";

/** A review request from the UI. `pr` is a URL, owner/repo#123 or a queue number; without it, local changes. */
export interface ReviewRequest {
  pr?: string;
  llm?: boolean;
  graph?: boolean;
  model?: string;
  effort?: string;
}

/** One line of a streamed review. */
export type ReviewEvent =
  | { type: "stage"; stage: ReviewStage; label: string }
  | { type: "briefing"; briefing: Briefing }
  | { type: "error"; message: string };

/** What the server asks of the engine. Tests pass fakes; `alden ui` passes the real thing (see api.ts). */
export interface UiApi {
  session(): Promise<unknown>;
  queue(options: { refresh: boolean; repos: string[]; orgs: string[] }): Promise<unknown>;
  review(request: ReviewRequest, onStage: (stage: ReviewStage, label: string) => void): Promise<Briefing>;
  /**
   * The desktop app, while you're away: briefs the first of the top PRs waiting on you that has no briefing for its
   * latest push. `{ prepared: null }` when there's nothing to do (or it's off).
   */
  prepareNext(): Promise<unknown>;
  /** Without a PR, which briefings are ready; with one ("owner/repo#12"), that briefing, or null if none or stale. */
  prepared(pr?: string): Promise<unknown>;
  /** GitHub sign-in from the UI: start the device flow, its status, open GitHub's page, or use the GitHub CLI's. */
  startSignIn(): Promise<unknown>;
  signInStatus(): Promise<unknown>;
  openSignIn(): Promise<unknown>;
  useGitHubCli(): Promise<unknown>;
  /**
   * Stores the Anthropic API key in the keychain, as `alden auth model` does; `null` removes it. Write-only: the answer
   * says where the key now comes from, never the key.
   */
  setModelKey(key: string | null): Promise<unknown>;
  /** The desktop app's `alden` command: whether it's installed, and installing it. */
  cliStatus(): Promise<unknown>;
  installCli(): Promise<unknown>;
  spend(): Promise<unknown>;
  config(): Promise<unknown>;
  /** `null` removes the setting, so its default applies again. */
  setConfig(key: string, value: string | null): Promise<unknown>;
  /** Records a verdict or a miss; returns the stored event. */
  addFeedback(input: unknown): Promise<unknown>;
  feedbackSummary(): Promise<unknown>;
  stats(options: { repo?: string; days: number; since?: string; refresh: boolean }): Promise<unknown>;
  /** What Alden knows about the reviewer in a repo (default: the repo `alden ui` was started in). */
  memory(repo?: string): Promise<unknown>;
  addMemory(input: { repo?: string; text: string }): Promise<unknown>;
  forgetMemory(input: { repo?: string; id: string }): Promise<unknown>;
  /** The rest of the Memory view: edit a note, undo a forget, pause or resume learning, forget everything. */
  changeMemory(input: MemoryChange): Promise<unknown>;
  /** Repos Alden knows something about, for the Memory view's list. */
  memoryRepos(): Promise<unknown>;
  /** A reaction to a PR in the last queue: "owner/repo#12". */
  react(input: { pr: string; reaction: "up" | "down" | "dismiss" | "clear" }): Promise<unknown>;
  /** Feedback events with repo names, titles, paths and notes removed, as `alden feedback --export` writes them. */
  exportFeedback(): Promise<unknown>;
  /** Whether anonymous usage stats are on, off or not yet asked, and anything forcing them off. */
  telemetry(): Promise<unknown>;
  setTelemetry(on: boolean): Promise<unknown>;
}

export type MemoryChange =
  | { repo?: string; action: "edit"; id: string; text: string }
  | { repo?: string; action: "restore"; id: string }
  | { repo?: string; action: "learning"; on: boolean }
  | { repo?: string; action: "forget-all" };

/** An error the UI should show as is, with an HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface UiServerOptions {
  api: UiApi;
  /** The built UI (index.html and assets). Missing: a page that says how to build it. */
  staticDir?: string;
  /** The built UI's files by relative path, for a standalone binary; used instead of `staticDir`. */
  files?: Map<string, Uint8Array>;
  port?: number;
  /** Fixed in tests; random otherwise. */
  token?: string;
}

export interface UiServer {
  server: Server;
  port: number;
  token: string;
  /** Where to point the browser: the token rides in the fragment, which browsers never send to servers. */
  url: string;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

const MAX_BODY_BYTES = 64 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, "Request too large.");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new ApiError(400, "Expected a JSON object.");
}

const sameToken = (given: string | undefined, token: string) =>
  given !== undefined && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));

/**
 * The local server behind `alden ui`: the built UI plus a JSON API over the engine, on 127.0.0.1 only.
 *
 * The API holds a GitHub token and can spend model money, so every call must carry the session token (from the URL
 * fragment, sent as `X-Alden-Token`), and the Host header must be this server's own address. That keeps out other
 * websites in the same browser (they can't read the token, and DNS rebinding changes the Host) and other users on
 * the machine (they can't see the token).
 */
export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const token = options.token ?? randomBytes(24).toString("base64url");
  let port = options.port ?? 0;
  const hostsAllowed = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof ApiError) send(res, error.status, { error: error.message });
      else send(res, 500, { error: (error as Error).message ?? "Something went wrong." });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostsAllowed().has(req.headers.host ?? "")) {
      send(res, 403, { error: "Wrong host." });
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (!url.pathname.startsWith("/api/")) {
      await serveStatic(url.pathname, res);
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !hostsAllowed().has(origin.replace(/^http:\/\//, ""))) {
      send(res, 403, { error: "Wrong origin." });
      return;
    }
    if (!sameToken(req.headers["x-alden-token"] as string | undefined, token)) {
      send(res, 401, { error: "Missing or wrong session token. Open the link `alden ui` printed." });
      return;
    }
    await route(req, res, url);
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { api } = options;
    const key = `${req.method} ${url.pathname}`;
    switch (key) {
      case "GET /api/session":
        send(res, 200, await api.session());
        return;
      case "GET /api/queue":
        send(
          res,
          200,
          await api.queue({
            refresh: url.searchParams.get("refresh") === "1",
            repos: url.searchParams.getAll("repo"),
            orgs: url.searchParams.getAll("org"),
          }),
        );
        return;
      case "POST /api/review":
        await streamReview(await readJsonBody(req), res);
        return;
      case "POST /api/prepare":
        send(res, 200, await api.prepareNext());
        return;
      case "GET /api/prepared": {
        const pr = url.searchParams.get("pr") ?? undefined;
        send(res, 200, await api.prepared(pr));
        return;
      }
      case "GET /api/spend":
        send(res, 200, await api.spend());
        return;
      case "GET /api/config":
        send(res, 200, await api.config());
        return;
      case "PUT /api/config": {
        const body = await readJsonBody(req);
        if (typeof body.key !== "string" || !(typeof body.value === "string" || body.value === null)) {
          throw new ApiError(400, "Send { key, value }: value a string, or null to remove the setting.");
        }
        send(res, 200, await api.setConfig(body.key, body.value));
        return;
      }
      case "GET /api/stats": {
        const days = Number(url.searchParams.get("days") ?? 90);
        const repo = url.searchParams.get("repo") ?? undefined;
        const since = url.searchParams.get("since") ?? undefined;
        send(
          res,
          200,
          await api.stats({
            days,
            refresh: url.searchParams.get("refresh") === "1",
            ...(repo ? { repo } : {}),
            ...(since ? { since } : {}),
          }),
        );
        return;
      }
      case "GET /api/feedback":
        send(res, 200, await api.feedbackSummary());
        return;
      case "POST /api/feedback":
        send(res, 200, await api.addFeedback(await readJsonBody(req)));
        return;
      case "GET /api/memory": {
        const repo = url.searchParams.get("repo") ?? undefined;
        send(res, 200, await api.memory(repo));
        return;
      }
      case "POST /api/memory": {
        const body = await readJsonBody(req);
        if (typeof body.text !== "string") throw new ApiError(400, "Send { text }, and optionally { repo }.");
        send(
          res,
          200,
          await api.addMemory({ text: body.text, ...(typeof body.repo === "string" ? { repo: body.repo } : {}) }),
        );
        return;
      }
      case "GET /api/memory/repos":
        send(res, 200, await api.memoryRepos());
        return;
      case "POST /api/memory/change": {
        const body = await readJsonBody(req);
        const repo = typeof body.repo === "string" ? { repo: body.repo } : {};
        const change: MemoryChange | undefined =
          body.action === "edit" && typeof body.id === "string" && typeof body.text === "string"
            ? { ...repo, action: "edit", id: body.id, text: body.text }
            : body.action === "restore" && typeof body.id === "string"
              ? { ...repo, action: "restore", id: body.id }
              : body.action === "learning" && typeof body.on === "boolean"
                ? { ...repo, action: "learning", on: body.on }
                : body.action === "forget-all"
                  ? { ...repo, action: "forget-all" }
                  : undefined;
        if (!change) throw new ApiError(400, "Send { action: edit | restore | learning | forget-all, … }.");
        send(res, 200, await api.changeMemory(change));
        return;
      }
      case "POST /api/reaction": {
        const body = await readJsonBody(req);
        const reactions = ["up", "down", "dismiss", "clear"] as const;
        const reaction = reactions.find((r) => r === body.reaction);
        if (typeof body.pr !== "string" || !reaction) {
          throw new ApiError(400, "Send { pr: owner/repo#12, reaction: up | down | dismiss | clear }.");
        }
        send(res, 200, await api.react({ pr: body.pr, reaction }));
        return;
      }
      case "POST /api/auth/device":
        send(res, 200, await api.startSignIn());
        return;
      case "GET /api/auth/device":
        send(res, 200, await api.signInStatus());
        return;
      case "POST /api/auth/device/open":
        send(res, 200, await api.openSignIn());
        return;
      case "POST /api/auth/gh":
        send(res, 200, await api.useGitHubCli());
        return;
      case "PUT /api/model-key": {
        const body = await readJsonBody(req);
        if (!(typeof body.key === "string" || body.key === null)) {
          throw new ApiError(400, "Send { key }: the API key, or null to remove the stored one.");
        }
        send(res, 200, await api.setModelKey(body.key));
        return;
      }
      case "GET /api/cli":
        send(res, 200, await api.cliStatus());
        return;
      case "POST /api/cli/install":
        send(res, 200, await api.installCli());
        return;
      case "GET /api/telemetry":
        send(res, 200, await api.telemetry());
        return;
      case "PUT /api/telemetry": {
        const body = await readJsonBody(req);
        if (typeof body.on !== "boolean") throw new ApiError(400, "Send { on: true | false }.");
        send(res, 200, await api.setTelemetry(body.on));
        return;
      }
      case "GET /api/feedback/export":
        send(res, 200, await api.exportFeedback());
        return;
      case "POST /api/memory/forget": {
        const body = await readJsonBody(req);
        if (typeof body.id !== "string") throw new ApiError(400, "Send { id }, and optionally { repo }.");
        send(
          res,
          200,
          await api.forgetMemory({ id: body.id, ...(typeof body.repo === "string" ? { repo: body.repo } : {}) }),
        );
        return;
      }
      default:
        send(res, 404, { error: `No such endpoint: ${key}` });
    }
  }

  /** Newline-delimited JSON: stage events as the review goes, then the briefing or an error. */
  async function streamReview(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const request: ReviewRequest = {
      ...(typeof body.pr === "string" && body.pr.trim() ? { pr: body.pr.trim() } : {}),
      ...(typeof body.llm === "boolean" ? { llm: body.llm } : {}),
      ...(typeof body.graph === "boolean" ? { graph: body.graph } : {}),
      ...(typeof body.model === "string" && body.model ? { model: body.model } : {}),
      ...(typeof body.effort === "string" && body.effort ? { effort: body.effort } : {}),
    };
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/x-ndjson; charset=utf-8" });
    const write = (event: ReviewEvent) => res.write(`${JSON.stringify(event)}\n`);
    try {
      const briefing = await options.api.review(request, (stage, label) => write({ type: "stage", stage, label }));
      write({ type: "briefing", briefing });
    } catch (error) {
      write({ type: "error", message: (error as Error).message });
    }
    res.end();
  }

  /** The built UI's files: in memory for a standalone binary, or from the UI directory. */
  async function readUiFile(relative: string): Promise<Uint8Array | undefined> {
    if (options.files) return options.files.get(relative);
    const dir = options.staticDir;
    if (!dir) return undefined;
    const file = join(dir, relative);
    // Only files inside the UI directory.
    if (!file.startsWith(dir + sep)) return undefined;
    try {
      return await readFile(file);
    } catch {
      return undefined;
    }
  }

  async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const index = await readUiFile("index.html");
    if (!index) {
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><meta charset=utf-8><title>Alden</title><p>The Alden UI isn't built. Run <code>pnpm --filter @alden/ui build</code>, then <code>pnpm build</code>.</p>",
      );
      return;
    }
    // Anything that isn't a file is the app (it routes on the client).
    const relative = normalize(decodeURIComponent(pathname))
      .replace(/^([/\\])+/, "")
      .split(sep)
      .join("/");
    const asset = !relative.startsWith("..") && extname(relative) ? await readUiFile(relative) : undefined;
    const name = asset ? relative : "index.html";
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": TYPES[extname(name)] ?? "application/octet-stream",
      ...(name.startsWith("assets/") ? { "Cache-Control": "public, max-age=31536000, immutable" } : {}),
    });
    res.end(asset ?? index);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  return {
    server,
    port,
    token,
    url: `http://127.0.0.1:${port}/#t=${token}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
