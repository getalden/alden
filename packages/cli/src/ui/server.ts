import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
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
  spend(): Promise<unknown>;
  config(): Promise<unknown>;
  setConfig(key: string, value: string): Promise<unknown>;
}

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
      case "GET /api/spend":
        send(res, 200, await api.spend());
        return;
      case "GET /api/config":
        send(res, 200, await api.config());
        return;
      case "PUT /api/config": {
        const body = await readJsonBody(req);
        if (typeof body.key !== "string" || typeof body.value !== "string") {
          throw new ApiError(400, "Send { key, value } as strings.");
        }
        send(res, 200, await api.setConfig(body.key, body.value));
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

  async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const dir = options.staticDir;
    if (!dir || !existsSync(join(dir, "index.html"))) {
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><meta charset=utf-8><title>Alden</title><p>The Alden UI isn't built. Run <code>pnpm --filter @alden/ui build</code>, then <code>pnpm build</code>.</p>",
      );
      return;
    }
    // Only files inside the UI directory; anything that isn't a file is the app (it routes on the client).
    const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
    let file = join(dir, relative);
    if (!file.startsWith(dir + sep) || !extname(file)) file = join(dir, "index.html");
    let content: Buffer;
    try {
      content = await readFile(file);
    } catch {
      content = await readFile(join(dir, "index.html"));
      file = join(dir, "index.html");
    }
    const immutable = file.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      ...(immutable ? { "Cache-Control": "public, max-age=31536000, immutable" } : {}),
    });
    res.end(content);
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
