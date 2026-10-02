import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Briefing } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, startUiServer, type UiApi, type UiServer } from "./server.js";

const TOKEN = "test-token-0123456789";
const briefing = { target: { kind: "local", repoRoot: "/r" }, files: [] } as unknown as Briefing;

let calls: { method: string; args: unknown }[];
const api: UiApi = {
  session: async () => ({ user: { login: "sam" } }),
  queue: async (options) => {
    calls.push({ method: "queue", args: options });
    return { needsYou: [], fastTrack: [] };
  },
  review: async (req, onStage) => {
    calls.push({ method: "review", args: req });
    if (req.pr === "bad") throw new ApiError(400, "Not a PR.");
    onStage("fetch", "Reading your local changes");
    onStage("checks", "Running checks");
    return briefing;
  },
  spend: async () => ({ spentToday: 0.12 }),
  config: async () => ({ config: {} }),
  addFeedback: async (input) => {
    calls.push({ method: "addFeedback", args: input });
    return { id: "1" };
  },
  feedbackSummary: async () => ({ verdicts: 0 }),
  memory: async (repo) => {
    calls.push({ method: "memory", args: repo });
    return { repo: repo ?? "acme/shop", items: [] };
  },
  addMemory: async (input) => {
    calls.push({ method: "addMemory", args: input });
    return { items: [] };
  },
  forgetMemory: async (input) => {
    calls.push({ method: "forgetMemory", args: input });
    return { items: [] };
  },
  changeMemory: async (input) => {
    calls.push({ method: "changeMemory", args: input });
    return { items: [] };
  },
  memoryRepos: async () => [{ repo: "acme/shop", items: 2 }],
  react: async (input) => {
    calls.push({ method: "react", args: input });
    return input;
  },
  exportFeedback: async () => [],
  stats: async (options) => {
    calls.push({ method: "stats", args: options });
    return { repo: options.repo };
  },
  setConfig: async (key, value) => {
    if (key === "nope") throw new ApiError(400, "Unknown config key: nope");
    calls.push({ method: "setConfig", args: { key, value } });
    return { config: {} };
  },
};

let ui: UiServer;
let staticDir: string;

beforeEach(async () => {
  calls = [];
  staticDir = await mkdtemp(join(tmpdir(), "alden-ui-"));
  await mkdir(join(staticDir, "assets"));
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Alden</title>");
  await writeFile(join(staticDir, "assets", "app.js"), "console.log(1)");
  ui = await startUiServer({ api, staticDir, token: TOKEN });
});

afterEach(async () => {
  await ui.close();
  await rm(staticDir, { recursive: true, force: true });
});

/** A raw request, so tests can send any Host and Origin. */
function call(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; headers: Record<string, unknown>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: ui.port,
        path,
        method: options.method ?? "GET",
        headers: { Host: `127.0.0.1:${ui.port}`, ...options.headers },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(JSON.stringify(options.body));
    req.end();
  });
}

const authed = { "X-Alden-Token": TOKEN };

describe("alden ui server", () => {
  it("prints a link with the token in the fragment, on 127.0.0.1", () => {
    expect(ui.url).toBe(`http://127.0.0.1:${ui.port}/#t=${TOKEN}`);
    expect(ui.server.address()).toMatchObject({ address: "127.0.0.1" });
  });

  it("refuses API calls without the session token", async () => {
    expect((await call("/api/session")).status).toBe(401);
    expect((await call("/api/session", { headers: { "X-Alden-Token": "wrong-token-012345678" } })).status).toBe(401);
    expect(JSON.parse((await call("/api/session", { headers: authed })).text)).toEqual({ user: { login: "sam" } });
  });

  it("refuses other hosts and origins, which is what DNS rebinding and other websites look like", async () => {
    expect((await call("/api/session", { headers: { ...authed, Host: `evil.example:${ui.port}` } })).status).toBe(403);
    expect((await call("/", { headers: { Host: "evil.example" } })).status).toBe(403);
    expect((await call("/api/session", { headers: { ...authed, Origin: "https://evil.example" } })).status).toBe(403);
    expect(
      (
        await call("/api/session", {
          headers: { ...authed, Host: `localhost:${ui.port}`, Origin: `http://localhost:${ui.port}` },
        })
      ).status,
    ).toBe(200);
  });

  it("passes queue filters through", async () => {
    await call("/api/queue?refresh=1&repo=a/b&repo=c/d&org=acme", { headers: authed });
    expect(calls).toEqual([{ method: "queue", args: { refresh: true, repos: ["a/b", "c/d"], orgs: ["acme"] } }]);
  });

  it("streams a review's stages, then its briefing", async () => {
    const res = await call("/api/review", {
      method: "POST",
      headers: authed,
      body: { llm: false, graph: true, effort: "low", ignored: 1 },
    });
    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    expect(
      res.text
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l)),
    ).toEqual([
      { type: "stage", stage: "fetch", label: "Reading your local changes" },
      { type: "stage", stage: "checks", label: "Running checks" },
      { type: "briefing", briefing },
    ]);
    expect(calls[0]).toEqual({ method: "review", args: { llm: false, graph: true, effort: "low" } });
  });

  it("streams a failed review as an error event", async () => {
    const res = await call("/api/review", { method: "POST", headers: authed, body: { pr: "bad" } });
    expect(JSON.parse(res.text.trim())).toEqual({ type: "error", message: "Not a PR." });
  });

  it("validates config changes and reports the engine's errors", async () => {
    expect((await call("/api/config", { method: "PUT", headers: authed, body: { key: "a" } })).status).toBe(400);
    const bad = await call("/api/config", { method: "PUT", headers: authed, body: { key: "nope", value: "1" } });
    expect([bad.status, JSON.parse(bad.text)]).toEqual([400, { error: "Unknown config key: nope" }]);
    await call("/api/config", { method: "PUT", headers: authed, body: { key: "model.name", value: "opus" } });
    expect(calls).toEqual([{ method: "setConfig", args: { key: "model.name", value: "opus" } }]);
  });

  it("passes stats options through", async () => {
    await call("/api/stats?repo=a/b&days=30&since=2026-09-01&refresh=1", { headers: authed });
    await call("/api/stats", { headers: authed });
    expect(calls).toEqual([
      { method: "stats", args: { repo: "a/b", days: 30, since: "2026-09-01", refresh: true } },
      { method: "stats", args: { days: 90, refresh: false } },
    ]);
  });

  it("records feedback and returns the summary", async () => {
    const body = { kind: "missed", note: "x" };
    const res = await call("/api/feedback", { method: "POST", headers: authed, body });
    expect([res.status, JSON.parse(res.text)]).toEqual([200, { id: "1" }]);
    expect(calls).toEqual([{ method: "addFeedback", args: body }]);
    expect(JSON.parse((await call("/api/feedback", { headers: authed })).text)).toEqual({ verdicts: 0 });
  });

  it("lists, adds and forgets memory, and checks the body", async () => {
    await call("/api/memory?repo=a/b", { headers: authed });
    await call("/api/memory", { method: "POST", headers: authed, body: { text: "Cents, not floats" } });
    await call("/api/memory/forget", { method: "POST", headers: authed, body: { repo: "a/b", id: "note:1" } });
    expect(calls).toEqual([
      { method: "memory", args: "a/b" },
      { method: "addMemory", args: { text: "Cents, not floats" } },
      { method: "forgetMemory", args: { repo: "a/b", id: "note:1" } },
    ]);
    expect((await call("/api/memory", { method: "POST", headers: authed, body: { note: 1 } })).status).toBe(400);
    expect((await call("/api/memory/forget", { method: "POST", headers: authed, body: {} })).status).toBe(400);
  });

  it("passes memory changes and reactions through, and checks their bodies", async () => {
    const post = (path: string, body: unknown) => call(path, { method: "POST", headers: authed, body });
    await post("/api/memory/change", { action: "edit", id: "note:1", text: "x" });
    await post("/api/memory/change", { repo: "a/b", action: "learning", on: false });
    await post("/api/memory/change", { action: "forget-all" });
    await post("/api/reaction", { pr: "a/b#1", reaction: "dismiss" });
    expect(calls).toEqual([
      { method: "changeMemory", args: { action: "edit", id: "note:1", text: "x" } },
      { method: "changeMemory", args: { repo: "a/b", action: "learning", on: false } },
      { method: "changeMemory", args: { action: "forget-all" } },
      { method: "react", args: { pr: "a/b#1", reaction: "dismiss" } },
    ]);
    expect((await post("/api/memory/change", { action: "edit", id: "note:1" })).status).toBe(400);
    expect((await post("/api/reaction", { pr: "a/b#1", reaction: "love" })).status).toBe(400);
    expect(JSON.parse((await call("/api/memory/repos", { headers: authed })).text)).toEqual([
      { repo: "acme/shop", items: 2 },
    ]);
    expect((await call("/api/feedback/export", { headers: authed })).status).toBe(200);
  });

  it("serves the UI without a token, the app for unknown paths, and nothing outside its folder", async () => {
    const index = await call("/");
    expect([index.status, index.text]).toEqual([200, "<!doctype html><title>Alden</title>"]);
    expect(index.headers["content-security-policy"]).toContain("default-src 'self'");
    expect((await call("/assets/app.js")).text).toBe("console.log(1)");
    expect((await call("/queue/some-view")).text).toContain("<title>Alden</title>");
    expect((await call("/../../../etc/passwd")).text).toContain("<title>Alden</title>");
    expect((await call("/%2e%2e/%2e%2e/etc/hosts")).text).toContain("<title>Alden</title>");
  });

  it("serves the UI from memory, as a standalone binary does", async () => {
    const files = new Map([
      ["index.html", new TextEncoder().encode("<title>embedded</title>")],
      ["assets/app.js", new TextEncoder().encode("1")],
    ]);
    const embedded = await startUiServer({ api, files, token: TOKEN });
    try {
      const get = (path: string) =>
        new Promise<string>((resolve) => {
          request(
            { host: "127.0.0.1", port: embedded.port, path, headers: { Host: `127.0.0.1:${embedded.port}` } },
            (r) => {
              let text = "";
              r.on("data", (c) => {
                text += c;
              });
              r.on("end", () => resolve(text));
            },
          ).end();
        });
      expect(await get("/")).toBe("<title>embedded</title>");
      expect(await get("/assets/app.js")).toBe("1");
      expect(await get("/stats")).toBe("<title>embedded</title>");
      expect(await get("/../../etc/passwd")).toBe("<title>embedded</title>");
    } finally {
      await embedded.close();
    }
  });

  it("says how to build the UI when it isn't built", async () => {
    const bare = await startUiServer({ api, token: TOKEN });
    try {
      const res = await new Promise<string>((resolve) => {
        request({ host: "127.0.0.1", port: bare.port, path: "/", headers: { Host: `127.0.0.1:${bare.port}` } }, (r) => {
          let text = "";
          r.on("data", (c) => {
            text += c;
          });
          r.on("end", () => resolve(text));
        }).end();
      });
      expect(res).toContain("isn't built");
    } finally {
      await bare.close();
    }
  });
});
