import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Briefing, ReviewDraft } from "@alden/schema";
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
  prepareNext: async () => {
    calls.push({ method: "prepareNext", args: undefined });
    return { prepared: { pr: "a/b#1" } };
  },
  prepared: async (pr) => {
    calls.push({ method: "prepared", args: pr });
    return pr ? null : [];
  },
  freshness: async (target) => {
    calls.push({ method: "freshness", args: target });
    return { state: "base_moved", baseRef: "main", commits: 4 };
  },
  startSignIn: async () => {
    calls.push({ method: "startSignIn", args: undefined });
    return { state: "waiting", userCode: "ABCD-1234" };
  },
  signInStatus: async () => ({ state: "idle" }),
  openSignIn: async () => ({ state: "waiting" }),
  useGitHubCli: async () => ({ login: "sam" }),
  setModelKey: async (key) => {
    calls.push({ method: "setModelKey", args: key });
    return { key: key ? { source: "alden", where: "the keychain" } : null };
  },
  modelSetup: {
    state: async () => ({ current: { available: false } }) as never,
    testKey: async (key, untested) => {
      calls.push({ method: "testKey", args: { key, untested } });
      return key.endsWith("bad")
        ? { ok: false, reason: "invalid", message: "Anthropic didn't accept that key." }
        : { ok: true, key: { source: "alden", where: "the key you stored" } };
    },
    useLocal: async (model, onEvent) => {
      calls.push({ method: "useLocal", args: model });
      if (model === "missing:1b") throw new ApiError(409, "Ollama isn't running.");
      onEvent({ type: "progress", status: "pulling manifest", completed: null, total: null });
      onEvent({ type: "done", model, baseUrl: "http://localhost:11434/v1" });
    },
    open: async (page) => {
      calls.push({ method: "open", args: page });
      return { opened: page };
    },
  },
  followUps: {
    check: async () => {
      calls.push({ method: "followUps.check", args: undefined });
      return {
        notifications: [{ pr: "a/b#1", title: "Fix \u001b[31mit", url: "u", text: "2 replies", events: ["e1", "e2"] }],
        sound: true,
      };
    },
    ack: async (ids) => {
      calls.push({ method: "followUps.ack", args: ids });
      return { acked: ids.length };
    },
    watch: async (pr) => {
      calls.push({ method: "followUps.watch", args: pr });
      return { pr, level: "your-turn" };
    },
    setWatch: async (pr, level) => {
      calls.push({ method: "followUps.setWatch", args: { pr, level } });
      return { pr, ...(level ? { override: level } : {}), level: level ?? "your-turn" };
    },
    noteQueue: (queue) => queue,
  },
  // Settings → Ranking has its own tests, in rank.test.ts.
  ranking: {
    state: async () => ({}) as never,
    save: async () => ({}) as never,
    preview: async () => ({}) as never,
  },
  clone: async (repo) => {
    calls.push({ method: "clone", args: repo });
    return { repo, path: null };
  },
  cliStatus: async () => ({ state: "missing" }),
  installCli: async () => {
    calls.push({ method: "installCli", args: undefined });
    return { state: "installed", path: "/usr/local/bin/alden" };
  },
  saveBriefing: async (b) => {
    calls.push({ method: "saveBriefing", args: b.target });
    return { path: "/Users/sam/Downloads/a-b-1-briefing.md", shown: "~/Downloads/a-b-1-briefing.md" };
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
  openLink: async (url) => {
    calls.push({ method: "openLink", args: url });
    return { opened: url };
  },
  saveFeedback: async () => ({ path: "/tmp/alden-feedback.json", shown: "/tmp/alden-feedback.json", events: 0 }),
  telemetry: async () => ({ consent: "unset", blocked: null }),
  setTelemetry: async (on) => {
    calls.push({ method: "setTelemetry", args: on });
    return { consent: on ? "on" : "off", blocked: null };
  },
  stats: async (options) => {
    calls.push({ method: "stats", args: options });
    return { repo: options.repo };
  },
  setConfig: async (key, value) => {
    if (key === "nope") throw new ApiError(400, "Unknown config key: nope");
    calls.push({ method: "setConfig", args: { key, value } });
    return { config: {} };
  },
  drafts: async (pr) => {
    calls.push({ method: "drafts", args: pr });
    return { drafts: [], unaddressed: [] };
  },
  addDraft: async (input, source) => {
    calls.push({ method: "addDraft", args: { input, source } });
    return { id: "d1", ...input, headSha: "h", source: source ?? "you" } as unknown as ReviewDraft;
  },
  editDraft: async (id, change) => {
    calls.push({ method: "editDraft", args: { id, change } });
    return { id } as unknown as ReviewDraft;
  },
  threads: async (pr, refresh) => {
    calls.push({ method: "threads", args: { pr, refresh } });
    return { schemaVersion: 1, pr, headSha: "h", viewer: "me", threads: [] };
  },
  deleteDraft: async (id) => {
    calls.push({ method: "deleteDraft", args: id });
    if (id === "gone") throw new ApiError(404, "No draft gone.");
    return { ok: true };
  },
  keepDrafts: async (input) => {
    calls.push({ method: "keepDrafts", args: input });
    return { kept: [] };
  },
  diff: async (pr, since) => {
    calls.push({ method: "diff", args: since === undefined ? pr : { pr, since } });
    if (pr === "a/b#404") throw new ApiError(502, "GitHub couldn't find a/b#404.");
    return {
      headSha: "h1",
      files: [
        {
          path: "src/\u001b[31mred.ts",
          status: "modified",
          hunks: [
            { header: "@@ -1 +1 @@", lines: [{ kind: "add", newLine: 1, text: "x = 1;\u001b]8;;https://evil\u0007" }] },
          ],
        },
      ],
    };
  },
  recordSeen: async (input) => {
    calls.push({ method: "recordSeen", args: input });
    return { recorded: input.places.length };
  },
  sendReview: async (input) => {
    calls.push({ method: "sendReview", args: input });
    if (input.pr === "a/b#403") throw new ApiError(403, "Your GitHub sign-in can't write reviews on a/b.");
    return { url: "https://github.com/a/b/pull/1#pullrequestreview-1", posted: 2, review: input.event };
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

/** A briefing that passes the schema, as a review returns it. */
const exportable: Briefing = {
  schemaVersion: 1,
  target: {
    kind: "pr",
    repo: "a/b",
    number: 1,
    url: "https://github.com/a/b/pull/1",
    title: "Fix \u001b[31mthe thing",
    author: "sam",
    baseRef: "main",
    headRef: "fix",
  },
  generatedAt: "2026-10-06T09:30:00.000Z",
  summary: { files: 1, additions: 1, deletions: 0, reviewableAdditions: 1, reviewableDeletions: 0 },
  files: [
    { path: "a.ts", status: "modified", kind: "code", additions: 1, deletions: 0, binary: false, patchMissing: false },
  ],
  checks: [],
  needsYourEyes: [],
  notChecked: [],
};

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

  it("turns a briefing into Markdown to copy or download, named after the PR", async () => {
    const res = await call("/api/briefing/markdown", {
      method: "POST",
      headers: authed,
      body: { briefing: exportable },
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as { markdown: string; fileName: string };
    expect(body.fileName).toBe("a-b-1-briefing.md");
    expect(body.markdown).toContain("# Fix the thing\n");
    expect(body.markdown).not.toContain("\u001b");
    const bad = await call("/api/briefing/markdown", { method: "POST", headers: authed, body: { briefing: { x: 1 } } });
    expect(bad.status).toBe(400);
  });

  it("saves a briefing through the engine, which says where it went", async () => {
    const res = await call("/api/briefing/save", { method: "POST", headers: authed, body: { briefing: exportable } });
    expect(JSON.parse(res.text)).toEqual({
      path: "/Users/sam/Downloads/a-b-1-briefing.md",
      shown: "~/Downloads/a-b-1-briefing.md",
    });
    expect(calls).toEqual([{ method: "saveBriefing", args: exportable.target }]);
  });

  it("takes a briefing to export that's larger than other requests may be", async () => {
    const big = { ...exportable, notChecked: Array.from({ length: 2_000 }, (_, i) => `${"x".repeat(100)} ${i}`) };
    expect(
      (await call("/api/briefing/markdown", { method: "POST", headers: authed, body: { briefing: big } })).status,
    ).toBe(200);
  });

  it("prepares the next briefing, and lists or gets prepared ones", async () => {
    const post = await call("/api/prepare", { method: "POST", headers: authed });
    expect(JSON.parse(post.text)).toEqual({ prepared: { pr: "a/b#1" } });
    expect((await call("/api/prepared", { headers: authed })).text).toBe("[]");
    expect((await call("/api/prepared?pr=a%2Fb%231", { headers: authed })).text).toBe("null");
    expect(calls).toEqual([
      { method: "prepareNext", args: undefined },
      { method: "prepared", args: undefined },
      { method: "prepared", args: "a/b#1" },
    ]);
  });

  it("says whether a briefing still matches its PR, given the briefing's target", async () => {
    const target = {
      kind: "pr",
      repo: "a/b",
      number: 1,
      url: "https://github.com/a/b/pull/1",
      title: "T",
      author: "sam",
      baseRef: "main",
      headRef: "feature",
      headSha: "abc",
      baseSha: "def",
      graphFrom: "merge",
    };
    const post = (body: unknown) => call("/api/freshness", { method: "POST", headers: authed, body });
    expect(JSON.parse((await post({ target })).text)).toEqual({ state: "base_moved", baseRef: "main", commits: 4 });
    expect(calls).toEqual([{ method: "freshness", args: target }]);
    expect((await post({ target: { kind: "pr" } })).status).toBe(400);
  });

  it("signs in and installs the command through the API", async () => {
    const post = (path: string) => call(path, { method: "POST", headers: authed });
    expect(JSON.parse((await post("/api/auth/device")).text)).toEqual({ state: "waiting", userCode: "ABCD-1234" });
    expect(JSON.parse((await call("/api/auth/device", { headers: authed })).text)).toEqual({ state: "idle" });
    expect(JSON.parse((await post("/api/auth/gh")).text)).toEqual({ login: "sam" });
    expect(JSON.parse((await post("/api/cli/install")).text)).toMatchObject({ state: "installed" });
    expect((await call("/api/auth/device", { method: "POST" })).status).toBe(401);
    expect(calls.map((c) => c.method)).toEqual(["startSignIn", "installCli"]);
  });

  it("strips escape codes from PR text before the UI sees it", async () => {
    const queue = api.queue;
    api.queue = async () =>
      ({ needsYou: [{ pr: { title: "Fix \u001b[31mred\u001b[0m output 🎉" } }], fastTrack: [] }) as never;
    try {
      const body = JSON.parse((await call("/api/queue", { headers: authed })).text);
      expect(body.needsYou[0].pr.title).toBe("Fix red output 🎉");
    } finally {
      api.queue = queue;
    }
  });

  it("opens web links for the desktop app, and nothing else", async () => {
    const open = (url: unknown) =>
      call("/api/open", { method: "POST", headers: authed, body: { url } }).then((r) => r.status);
    expect(await open("https://github.com/a/b/pull/1")).toBe(200);
    expect(calls).toEqual([{ method: "openLink", args: "https://github.com/a/b/pull/1" }]);
    expect(await open("file:///etc/passwd")).toBe(400);
    expect(await open("javascript:alert(1)")).toBe(400);
    expect(await open(`http://127.0.0.1:${ui.port}/#t=${TOKEN}`)).toBe(400);
    expect(await open("not a url")).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("passes queue filters through", async () => {
    await call("/api/queue?refresh=1&repo=a/b&repo=c/d&org=acme", { headers: authed });
    expect(calls).toEqual([{ method: "queue", args: { refresh: true, repos: ["a/b", "c/d"], orgs: ["acme"] } }]);
    calls.length = 0;
    await call("/api/queue?cached=1", { headers: authed });
    expect(calls).toEqual([{ method: "queue", args: { refresh: false, repos: [], orgs: [], cached: true } }]);
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

  it("checks follow-ups, acknowledges what was shown, and reads and sets a PR's level", async () => {
    const checked = await call("/api/follow-ups", { headers: authed });
    expect(JSON.parse(checked.text)).toEqual({
      notifications: [{ pr: "a/b#1", title: "Fix it", url: "u", text: "2 replies", events: ["e1", "e2"] }],
      sound: true,
    });
    const ack = await call("/api/follow-ups/ack", { method: "POST", headers: authed, body: { events: ["e1", "e2"] } });
    expect(JSON.parse(ack.text)).toEqual({ acked: 2 });
    for (const body of [{}, { events: "e1" }, { events: [1] }]) {
      expect((await call("/api/follow-ups/ack", { method: "POST", headers: authed, body })).status).toBe(400);
    }

    expect((await call("/api/watch", { headers: authed })).status).toBe(400);
    const watch = await call(`/api/watch?pr=${encodeURIComponent("a/b#1")}`, { headers: authed });
    expect(JSON.parse(watch.text)).toEqual({ pr: "a/b#1", level: "your-turn" });
    const set = await call(`/api/watch?pr=${encodeURIComponent("a/b#1")}`, {
      method: "PUT",
      headers: authed,
      body: { level: "every-reply" },
    });
    expect(JSON.parse(set.text)).toEqual({ pr: "a/b#1", override: "every-reply", level: "every-reply" });
    await call(`/api/watch?pr=${encodeURIComponent("a/b#1")}`, {
      method: "PUT",
      headers: authed,
      body: { level: null },
    });
    for (const body of [{}, { level: "loud" }]) {
      const bad = await call(`/api/watch?pr=${encodeURIComponent("a/b#1")}`, { method: "PUT", headers: authed, body });
      expect(bad.status).toBe(400);
    }
    expect(calls).toEqual([
      { method: "followUps.check", args: undefined },
      { method: "followUps.ack", args: ["e1", "e2"] },
      { method: "followUps.watch", args: "a/b#1" },
      { method: "followUps.setWatch", args: { pr: "a/b#1", level: "every-reply" } },
      { method: "followUps.setWatch", args: { pr: "a/b#1", level: null } },
    ]);
  });

  it("validates config changes and reports the engine's errors", async () => {
    expect((await call("/api/config", { method: "PUT", headers: authed, body: { key: "a" } })).status).toBe(400);
    const bad = await call("/api/config", { method: "PUT", headers: authed, body: { key: "nope", value: "1" } });
    expect([bad.status, JSON.parse(bad.text)]).toEqual([400, { error: "Unknown config key: nope" }]);
    await call("/api/config", { method: "PUT", headers: authed, body: { key: "model.name", value: "opus" } });
    expect(calls).toEqual([{ method: "setConfig", args: { key: "model.name", value: "opus" } }]);
  });

  it("stores the model key without ever sending it back, and checks the body", async () => {
    const key = `sk-ant-api03-${"a".repeat(40)}`;
    const res = await call("/api/model-key", { method: "PUT", headers: authed, body: { key } });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(key);
    await call("/api/model-key", { method: "PUT", headers: authed, body: { key: null } });
    expect((await call("/api/model-key", { method: "PUT", headers: authed, body: {} })).status).toBe(400);
    expect(calls).toEqual([
      { method: "setModelKey", args: key },
      { method: "setModelKey", args: null },
    ]);
  });

  it("sets up a model: tests a key without sending it back, streams a local model, opens only its own pages", async () => {
    const post = (path: string, body: unknown) => call(path, { method: "POST", headers: authed, body });
    expect(JSON.parse((await call("/api/model-setup", { headers: authed })).text)).toEqual({
      current: { available: false },
    });
    const key = `sk-ant-api03-${"z".repeat(40)}`;
    const tested = await post("/api/model-setup/test-key", { key });
    expect(JSON.parse(tested.text)).toEqual({ ok: true, key: { source: "alden", where: "the key you stored" } });
    expect(tested.text).not.toContain(key);
    expect(JSON.parse((await post("/api/model-setup/test-key", { key: "sk-bad" })).text)).toMatchObject({ ok: false });
    expect((await post("/api/model-setup/test-key", {})).status).toBe(400);
    await post("/api/model-setup/test-key", { key, untested: true });

    const local = await post("/api/model-setup/local", { model: "qwen2.5-coder:7b" });
    expect(local.headers["content-type"]).toContain("application/x-ndjson");
    expect(
      local.text
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).type),
    ).toEqual(["progress", "done"]);
    expect(JSON.parse((await post("/api/model-setup/local", { model: "missing:1b" })).text.trim())).toEqual({
      type: "error",
      message: "Ollama isn't running.",
    });
    expect((await post("/api/model-setup/local", {})).status).toBe(400);

    expect(JSON.parse((await post("/api/model-setup/open", { page: "cloud" })).text)).toEqual({ opened: "cloud" });
    expect((await post("/api/model-setup/open", { page: "https://evil.example" })).status).toBe(400);
    expect((await call("/api/model-setup", { method: "GET" })).status).toBe(401);
    expect(calls).toEqual([
      { method: "testKey", args: { key, untested: false } },
      { method: "testKey", args: { key: "sk-bad", untested: false } },
      { method: "testKey", args: { key, untested: true } },
      { method: "useLocal", args: "qwen2.5-coder:7b" },
      { method: "useLocal", args: "missing:1b" },
      { method: "open", args: "cloud" },
    ]);
  });

  it("says which clone a repo's callers come from", async () => {
    const res = await call("/api/clone?repo=acme/shop", { headers: authed });
    expect(JSON.parse(res.text)).toEqual({ repo: "acme/shop", path: null });
    expect((await call("/api/clone?repo=nope", { headers: authed })).status).toBe(400);
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

  it("serves a diff, for a PR or the local changes, with control sequences stripped", async () => {
    const pr = await call("/api/diff?pr=a%2Fb%231", { headers: authed });
    expect(pr.status).toBe(200);
    const body = JSON.parse(pr.text);
    expect(body.headSha).toBe("h1");
    expect(body.files[0].path).toBe("src/red.ts");
    expect(body.files[0].hunks[0].lines[0].text).toBe("x = 1;");
    expect((await call("/api/diff", { headers: authed })).status).toBe(200);
    expect((await call("/api/diff?pr=%20", { headers: authed })).status).toBe(200);
    expect(calls).toEqual([
      { method: "diff", args: "a/b#1" },
      { method: "diff", args: undefined },
      { method: "diff", args: undefined },
    ]);
    const missing = await call("/api/diff?pr=a%2Fb%23404", { headers: authed });
    expect([missing.status, JSON.parse(missing.text)]).toEqual([502, { error: "GitHub couldn't find a/b#404." }]);
    // The same session token and host checks as every route.
    expect((await call("/api/diff?pr=a%2Fb%231")).status).toBe(401);
    expect((await call("/api/diff", { headers: { ...authed, Host: "evil.example:80" } })).status).toBe(403);
  });

  it("narrows a PR's diff to the changes since a commit, and only takes a commit for it", async () => {
    expect((await call("/api/diff?pr=a%2Fb%231&since=abc1234", { headers: authed })).status).toBe(200);
    expect(calls).toEqual([{ method: "diff", args: { pr: "a/b#1", since: "abc1234" } }]);
    for (const query of ["pr=a%2Fb%231&since=main", "pr=a%2Fb%231&since=abc..def", "since=abc1234"]) {
      expect((await call(`/api/diff?${query}`, { headers: authed })).status).toBe(400);
    }
    expect(calls).toHaveLength(1);
  });

  it("passes drafts and sending through, always as yours, and checks their bodies", async () => {
    const send = (method: string, path: string, body?: unknown) =>
      call(path, { method, headers: authed, ...(body === undefined ? {} : { body }) });
    expect(JSON.parse((await send("GET", "/api/drafts?pr=a%2Fb%231")).text)).toEqual({ drafts: [], unaddressed: [] });
    // A "source" in the body is ignored: only Claude Code drafts as Claude.
    await send("POST", "/api/drafts", { pr: "a/b#1", path: "x.ts", line: 3, body: "Hm?", source: "claude" });
    await send("POST", "/api/drafts", { pr: "a/b#1", body: "Overall fine." });
    await send("PATCH", "/api/drafts/d1", { body: "Hm!" });
    await send("PATCH", "/api/drafts/d1", { path: "x.ts", line: 4, side: "LEFT" });
    await send("DELETE", "/api/drafts/d1");
    await send("POST", "/api/drafts", {
      pr: "a/b#1",
      path: "x.ts",
      startLine: 2,
      line: 4,
      body: "",
      suggestion: "y();",
    });
    await send("PATCH", "/api/drafts/d2", { suggestion: "" });
    await send("PATCH", "/api/drafts/d2", { suggestion: null, body: "No change after all" });
    await send("PATCH", "/api/drafts/d2", { path: "x.ts", startLine: 5, line: 6 });
    await send("POST", "/api/review/send", { pr: "a/b#1", event: "APPROVE" });
    expect(calls).toEqual([
      { method: "drafts", args: "a/b#1" },
      { method: "addDraft", args: { input: { pr: "a/b#1", body: "Hm?", path: "x.ts", line: 3 }, source: "you" } },
      { method: "addDraft", args: { input: { pr: "a/b#1", body: "Overall fine." }, source: "you" } },
      { method: "editDraft", args: { id: "d1", change: { body: "Hm!" } } },
      { method: "editDraft", args: { id: "d1", change: { path: "x.ts", line: 4, side: "LEFT" } } },
      { method: "deleteDraft", args: "d1" },
      {
        method: "addDraft",
        args: {
          input: { pr: "a/b#1", body: "", path: "x.ts", line: 4, startLine: 2, suggestion: "y();" },
          source: "you",
        },
      },
      { method: "editDraft", args: { id: "d2", change: { suggestion: "" } } },
      { method: "editDraft", args: { id: "d2", change: { body: "No change after all", suggestion: null } } },
      { method: "editDraft", args: { id: "d2", change: { path: "x.ts", line: 6, startLine: 5 } } },
      { method: "sendReview", args: { pr: "a/b#1", event: "APPROVE" } },
    ]);
    expect((await send("GET", "/api/drafts")).status).toBe(400);
    expect((await send("POST", "/api/drafts", { pr: "a/b#1" })).status).toBe(400);
    expect((await send("POST", "/api/drafts", { pr: "a/b#1", body: "x", line: 3 })).status).toBe(400);
    expect((await send("POST", "/api/drafts", { pr: "a/b#1", body: "x", path: "x.ts", line: 0 })).status).toBe(400);
    expect((await send("PATCH", "/api/drafts/d1", {})).status).toBe(400);
    expect((await send("DELETE", "/api/drafts/gone")).status).toBe(404);
    expect((await send("POST", "/api/drafts", { pr: "a/b#1", suggestion: "x" })).status).toBe(200);
    expect((await send("POST", "/api/drafts", { pr: "a/b#1", body: "x", startLine: 2 })).status).toBe(400);
    // A whole file: path alone, which the engine makes a note linking to it. A range still needs its last line.
    calls.length = 0;
    expect((await send("POST", "/api/drafts", { pr: "a/b#1", body: "x", path: "README.md" })).status).toBe(200);
    expect(calls).toEqual([
      { method: "addDraft", args: { input: { pr: "a/b#1", body: "x", path: "README.md" }, source: "you" } },
    ]);
    expect((await send("POST", "/api/drafts", { pr: "a/b#1", body: "x", path: "a.ts", startLine: 2 })).status).toBe(
      400,
    );
    expect(
      (await send("POST", "/api/drafts", { pr: "a/b#1", body: "x", path: "x.ts", line: 3, startLine: 1.5 })).status,
    ).toBe(400);
    expect((await send("POST", "/api/drafts", { pr: "a/b#1", body: "x", suggestion: 3 })).status).toBe(400);
    expect((await send("POST", "/api/drafts", { pr: "a/b#1", body: "x", suggestion: null })).status).toBe(400);
    expect((await send("POST", "/api/review/send", { pr: "a/b#1", event: "MERGE" })).status).toBe(400);
    const refused = await send("POST", "/api/review/send", { pr: "a/b#403", event: "COMMENT", body: "x" });
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.text).error).toMatch(/can't write reviews/);
    // The same session token as every route.
    expect((await call("/api/review/send", { method: "POST", body: { pr: "a/b#1", event: "APPROVE" } })).status).toBe(
      401,
    );
  });

  it("reads a PR's threads, and passes replies through as drafts", async () => {
    const send = (method: string, path: string, body?: unknown) =>
      call(path, { method, headers: authed, ...(body === undefined ? {} : { body }) });
    calls.length = 0;
    expect((await send("GET", "/api/threads?pr=a%2Fb%231")).status).toBe(200);
    await send("GET", "/api/threads?pr=a%2Fb%231&refresh=1");
    await send("POST", "/api/drafts", { pr: "a/b#1", inReplyTo: "PRRT_kwDO1", body: "Fixed." });
    await send("POST", "/api/drafts", { pr: "a/b#1", inReplyTo: "PRRT_kwDO2", resolve: true });
    await send("PATCH", "/api/drafts/d1", { resolve: true });
    expect(calls).toEqual([
      { method: "threads", args: { pr: "a/b#1", refresh: false } },
      { method: "threads", args: { pr: "a/b#1", refresh: true } },
      { method: "addDraft", args: { input: { pr: "a/b#1", body: "Fixed.", inReplyTo: "PRRT_kwDO1" }, source: "you" } },
      {
        method: "addDraft",
        args: { input: { pr: "a/b#1", body: "", inReplyTo: "PRRT_kwDO2", resolve: true }, source: "you" },
      },
      { method: "editDraft", args: { id: "d1", change: { resolve: true } } },
    ]);
    expect((await send("GET", "/api/threads")).status).toBe(400);
    expect((await send("POST", "/api/drafts", { pr: "a/b#1", inReplyTo: 3, body: "x" })).status).toBe(400);
    expect((await send("POST", "/api/drafts", { pr: "a/b#1", inReplyTo: "T", resolve: "yes" })).status).toBe(400);
    // Only a reply resolves.
    expect((await send("POST", "/api/drafts", { pr: "a/b#1", body: "x", resolve: true })).status).toBe(400);
  });

  it("keeps Alden's drafts by id or for a whole PR, and checks the body", async () => {
    const post = (body: unknown) => call("/api/drafts/keep", { method: "POST", headers: authed, body });
    expect((await post({ ids: ["d1", "d2"] })).status).toBe(200);
    expect((await post({ pr: "a/b#1" })).status).toBe(200);
    expect(calls).toEqual([
      { method: "keepDrafts", args: { ids: ["d1", "d2"] } },
      { method: "keepDrafts", args: { pr: "a/b#1" } },
    ]);
    expect((await post({})).status).toBe(400);
    expect((await post({ ids: "d1" })).status).toBe(400);
    expect((await post({ ids: ["../x"] })).status).toBe(400);
    expect((await post({ pr: 7 })).status).toBe(400);
    expect((await call("/api/drafts/keep", { method: "POST", body: { pr: "a/b#1" } })).status).toBe(401);
  });

  it("passes memory changes and reactions through, and checks their bodies", async () => {
    const post = (path: string, body: unknown) => call(path, { method: "POST", headers: authed, body });
    await post("/api/memory/change", { action: "edit", id: "note:1", text: "x" });
    await post("/api/memory/change", { repo: "a/b", action: "learning", on: false });
    await post("/api/memory/change", { action: "forget-all" });
    await post("/api/memory/change", { repo: "a/b", action: "exclude", id: "note:1", path: "app/api" });
    await post("/api/memory/change", { action: "include", id: "note:1", path: "app/api" });
    await post("/api/reaction", { pr: "a/b#1", reaction: "dismiss" });
    expect(calls).toEqual([
      { method: "changeMemory", args: { action: "edit", id: "note:1", text: "x" } },
      { method: "changeMemory", args: { repo: "a/b", action: "learning", on: false } },
      { method: "changeMemory", args: { action: "forget-all" } },
      { method: "changeMemory", args: { repo: "a/b", action: "exclude", id: "note:1", path: "app/api" } },
      { method: "changeMemory", args: { action: "include", id: "note:1", path: "app/api" } },
      { method: "react", args: { pr: "a/b#1", reaction: "dismiss" } },
    ]);
    expect((await post("/api/memory/change", { action: "edit", id: "note:1" })).status).toBe(400);
    expect((await post("/api/memory/change", { action: "exclude", id: "note:1" })).status).toBe(400);
    expect((await post("/api/reaction", { pr: "a/b#1", reaction: "love" })).status).toBe(400);
    expect(JSON.parse((await call("/api/memory/repos", { headers: authed })).text)).toEqual([
      { repo: "acme/shop", items: 2 },
    ]);
    expect((await call("/api/feedback/export", { headers: authed })).status).toBe(200);
    expect(JSON.parse((await call("/api/telemetry", { headers: authed })).text)).toEqual({
      consent: "unset",
      blocked: null,
    });
    expect((await call("/api/telemetry", { method: "PUT", headers: authed, body: { on: "yes" } })).status).toBe(400);
    await call("/api/telemetry", { method: "PUT", headers: authed, body: { on: true } });
    expect(calls.at(-1)).toEqual({ method: "setTelemetry", args: true });
  });

  it("records the places you saw, checking the body and keeping it small", async () => {
    const post = (body: unknown, headers: Record<string, string> = authed) =>
      call("/api/seen", { method: "POST", headers, body });
    const place = { checkId: "callers.outside", path: "src/pay.ts", line: 12, how: "guided" };
    expect((await post({ pr: "acme/shop#412", headSha: "abc1234", places: [place] }, {})).status).toBe(401);
    const ok = await post({ pr: "acme/shop#412", headSha: "abc1234", places: [place, { path: "a.ts", how: "diff" }] });
    expect([ok.status, JSON.parse(ok.text)]).toEqual([200, { recorded: 2 }]);
    expect(calls).toEqual([
      {
        method: "recordSeen",
        args: { pr: "acme/shop#412", headSha: "abc1234", places: [place, { path: "a.ts", how: "diff" }] },
      },
    ]);
    const bad = [
      { pr: "acme/shop", headSha: "abc1234", places: [place] },
      { pr: "acme/shop#1", headSha: "not a sha", places: [place] },
      { pr: "acme/shop#1", headSha: "abc1234", places: [] },
      { pr: "acme/shop#1", headSha: "abc1234", places: [{ ...place, how: "glanced" }] },
      { pr: "acme/shop#1", headSha: "abc1234", places: [{ ...place, line: 0 }] },
      { pr: "acme/shop#1", headSha: "abc1234", places: [{ ...place, path: "" }] },
      { pr: "acme/shop#1", headSha: "abc1234", places: [{ ...place, checkId: "<script>" }] },
      { pr: "acme/shop#1", headSha: "abc1234", places: Array.from({ length: 51 }, () => place) },
    ];
    for (const body of bad) expect((await post(body)).status).toBe(400);
    const big = { pr: "acme/shop#1", headSha: "abc1234", places: [{ path: "x".repeat(20_000), how: "diff" }] };
    expect((await post(big)).status).toBe(413);
    expect(calls).toHaveLength(1);
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
