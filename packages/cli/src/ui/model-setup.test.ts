import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@alden/core";
import type { LocalSetupEvent } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createModelSetupApi } from "./model-setup.js";

let home: string;
const saved = { home: process.env.ALDEN_HOME, ollama: process.env.OLLAMA_HOST };
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "alden-model-setup-"));
  process.env.ALDEN_HOME = home;
  delete process.env.OLLAMA_HOST;
});
afterEach(async () => {
  for (const [name, value] of [
    ["ALDEN_HOME", saved.home],
    ["OLLAMA_HOST", saved.ollama],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(home, { recursive: true, force: true });
});

/** A fake Ollama with `pulled` models; /api/pull streams two lines. */
function ollama(pulled: string[]) {
  const paths: string[] = [];
  const doFetch = (async (url: string) => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path === "/api/tags") return Response.json({ models: pulled.map((name) => ({ name, size: 1 })) });
    if (path === "/api/version") return Response.json({ version: "0.12.3" });
    if (path === "/api/pull") {
      return new Response(
        `${JSON.stringify({ status: "pulling manifest" })}\n${JSON.stringify({ status: "success" })}\n`,
      );
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { doFetch, paths };
}

describe("model setup from the UI", () => {
  it("uses a pulled model straight away, and pulls one that isn't there", async () => {
    const pulled = ollama(["qwen2.5-coder:7b"]);
    const events: LocalSetupEvent[] = [];
    const api = createModelSetupApi({ cwd: home, fetch: pulled.doFetch });
    await api.useLocal("qwen2.5-coder:7b", (e) => events.push(e), new AbortController().signal);
    expect(pulled.paths).not.toContain("/api/pull");
    expect(events).toEqual([{ type: "done", model: "qwen2.5-coder:7b", baseUrl: "http://localhost:11434/v1" }]);
    expect((await loadConfig(home)).model).toMatchObject({ provider: "openai-compatible", name: "qwen2.5-coder:7b" });

    const empty = ollama([]);
    const more: LocalSetupEvent[] = [];
    await createModelSetupApi({ cwd: home, fetch: empty.doFetch }).useLocal(
      "qwen2.5-coder:14b",
      (e) => more.push(e),
      new AbortController().signal,
    );
    expect(more.map((e) => e.type)).toEqual(["progress", "progress", "done"]);
    expect((await loadConfig(home)).model.name).toBe("qwen2.5-coder:14b");
  });

  it("says when Ollama isn't running, and refuses names that aren't models", async () => {
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const api = createModelSetupApi({ cwd: home, fetch: offline });
    const signal = new AbortController().signal;
    await expect(api.useLocal("qwen2.5-coder:7b", () => {}, signal)).rejects.toMatchObject({ status: 409 });
    await expect(api.useLocal("../api/delete", () => {}, signal)).rejects.toMatchObject({ status: 400 });
    expect((await loadConfig(home)).model.provider).toBe("anthropic");
  });
});
