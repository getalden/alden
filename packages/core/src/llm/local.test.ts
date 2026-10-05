import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import {
  detectOllama,
  isLocalModelName,
  LOCAL_MODEL_TABLE,
  ollamaUrl,
  type PullProgress,
  pullOllamaModel,
  recommendLocalModel,
  useLocalModel,
} from "./local.js";

const model = (name: string) => ({ name, sizeBytes: 1, parameterSize: null });

describe("recommendLocalModel", () => {
  it("picks a model by memory, from the one table", () => {
    expect(recommendLocalModel(8, []).model).toBe(LOCAL_MODEL_TABLE[0]?.model);
    expect(recommendLocalModel(16, []).model).toBe(LOCAL_MODEL_TABLE[1]?.model);
    expect(recommendLocalModel(24, [])).toMatchObject({ model: "qwen2.5-coder:14b", installed: false });
    expect(recommendLocalModel(64, [])).toMatchObject({ model: "qwen3-coder:30b", installed: false });
  });

  it("uses a pulled model when it fits: the machine's own, a variant of it, or a smaller one rather than a download", () => {
    expect(recommendLocalModel(24, [model("qwen2.5-coder:14b")])).toMatchObject({ installed: true });
    expect(recommendLocalModel(8, [model("qwen2.5-coder:7b-instruct-q8_0")])).toMatchObject({
      model: "qwen2.5-coder:7b-instruct-q8_0",
      installed: true,
    });
    expect(recommendLocalModel(48, [model("llama3.2:3b"), model("qwen2.5-coder:7b")])).toMatchObject({
      model: "qwen2.5-coder:7b",
      installed: true,
      why: "already pulled, and fits your memory",
    });
    // Too big for the machine: suggest the one that fits.
    expect(recommendLocalModel(8, [model("qwen3-coder:30b")])).toMatchObject({
      model: "qwen2.5-coder:7b",
      installed: false,
    });
  });
});

describe("ollamaUrl", () => {
  it("reads OLLAMA_HOST the way Ollama does", () => {
    expect(ollamaUrl({})).toBe("http://localhost:11434");
    expect(ollamaUrl({ OLLAMA_HOST: "0.0.0.0" })).toBe("http://localhost:11434");
    expect(ollamaUrl({ OLLAMA_HOST: "127.0.0.1:11500" })).toBe("http://127.0.0.1:11500");
    expect(ollamaUrl({ OLLAMA_HOST: ":11500" })).toBe("http://localhost:11500");
    expect(ollamaUrl({ OLLAMA_HOST: "http://gpu-box:11434/" })).toBe("http://gpu-box:11434");
    expect(ollamaUrl({ OLLAMA_HOST: "https://ollama.example.com" })).toBe("https://ollama.example.com");
  });
});

describe("detectOllama", () => {
  it("lists the pulled models and the version", async () => {
    const urls: string[] = [];
    const doFetch = (async (url: string) => {
      urls.push(url);
      return url.endsWith("/api/tags")
        ? Response.json({
            models: [{ name: "qwen2.5-coder:7b", size: 4_683_087_332, details: { parameter_size: "7.6B" } }],
          })
        : Response.json({ version: "0.12.3" });
    }) as typeof fetch;
    expect(await detectOllama("http://localhost:11434", doFetch)).toEqual({
      reachable: true,
      url: "http://localhost:11434",
      version: "0.12.3",
      models: [{ name: "qwen2.5-coder:7b", sizeBytes: 4_683_087_332, parameterSize: "7.6B" }],
      reason: null,
    });
    expect(urls).toEqual(["http://localhost:11434/api/tags", "http://localhost:11434/api/version"]);
  });

  it("says when Ollama isn't there, without throwing", async () => {
    const refused = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await detectOllama("http://localhost:11434", refused)).toMatchObject({
      reachable: false,
      models: [],
      reason: "Ollama isn't running at http://localhost:11434, or isn't installed.",
    });
    const other = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    expect((await detectOllama("http://localhost:11434", other)).reachable).toBe(false);
  });
});

/** A streamed /api/pull answer, split mid-line as a network would. */
function pullStream(lines: object[]): Response {
  const text = lines.map((l) => JSON.stringify(l)).join("\n");
  const cut = Math.floor(text.length / 2);
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text.slice(0, cut)));
        controller.enqueue(encoder.encode(`${text.slice(cut)}\n`));
        controller.close();
      },
    }),
  );
}

describe("pullOllamaModel", () => {
  it("streams the progress and finishes on success", async () => {
    let sent: unknown;
    const doFetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return pullStream([
        { status: "pulling manifest" },
        { status: "pulling 6a0746a1ec1a", digest: "sha256:6a07", total: 100, completed: 40 },
        { status: "pulling 6a0746a1ec1a", digest: "sha256:6a07", total: 100, completed: 100 },
        { status: "verifying sha256 digest" },
        { status: "success" },
      ]);
    }) as typeof fetch;
    const seen: PullProgress[] = [];
    await pullOllamaModel("qwen2.5-coder:7b", (p) => seen.push(p), { url: "http://localhost:11434", fetch: doFetch });
    expect(sent).toEqual({ model: "qwen2.5-coder:7b", stream: true });
    expect(seen.map((p) => p.status)).toEqual([
      "pulling manifest",
      "pulling 6a0746a1ec1a",
      "pulling 6a0746a1ec1a",
      "verifying sha256 digest",
      "success",
    ]);
    expect(seen[1]).toEqual({ status: "pulling 6a0746a1ec1a", completed: 40, total: 100 });
  });

  it("passes on Ollama's error, and a stream that stops early", async () => {
    const failing = (async () =>
      pullStream([{ status: "pulling manifest" }, { error: "file does not exist" }])) as typeof fetch;
    await expect(pullOllamaModel("nope:1b", () => {}, { fetch: failing })).rejects.toThrow(/file does not exist/);
    const short = (async () => pullStream([{ status: "pulling manifest" }])) as typeof fetch;
    await expect(pullOllamaModel("qwen2.5-coder:7b", () => {}, { fetch: short })).rejects.toThrow(/stopped before/);
  });

  it("refuses names that aren't model names", async () => {
    expect(isLocalModelName("qwen2.5-coder:14b")).toBe(true);
    expect(isLocalModelName("library/qwen2.5-coder:latest")).toBe(true);
    expect(isLocalModelName("../api/delete")).toBe(false);
    expect(isLocalModelName("a b")).toBe(false);
    await expect(pullOllamaModel("x/../y", () => {})).rejects.toThrow(/isn't a model name/);
  });
});

describe("useLocalModel", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "alden-local-"));
    process.env.ALDEN_HOME = home;
  });
  afterEach(async () => {
    delete process.env.ALDEN_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("points the openai-compatible provider at the model, with the address only when it isn't the default", async () => {
    expect(await useLocalModel("qwen2.5-coder:14b", "http://localhost:11434")).toBe("http://localhost:11434/v1");
    let config = await loadConfig(home);
    expect(config.model).toMatchObject({ provider: "openai-compatible", name: "qwen2.5-coder:14b" });
    expect(config.model.baseUrl).toBeUndefined();

    await useLocalModel("qwen2.5-coder:7b", "http://gpu-box:11434");
    config = await loadConfig(home);
    expect(config.model).toMatchObject({ name: "qwen2.5-coder:7b", baseUrl: "http://gpu-box:11434/v1" });
  });
});
