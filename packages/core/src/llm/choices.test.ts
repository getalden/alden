import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, userConfigPath } from "../config.js";
import type { CredentialStore } from "../github/credentials.js";
import { type ModelChoicesDeps, type ModelPickError, modelChoices, pickModel } from "./choices.js";

const store = (key?: string): CredentialStore => ({
  get: async () => key,
  set: async () => {},
  delete: async () => {},
});

/** A fake Ollama: running with `models` pulled, or not running at all. */
function ollama(models: string[] | null): typeof fetch {
  return (async (url: string) => {
    if (models === null) throw new TypeError("fetch failed");
    if (String(url).endsWith("/api/tags")) return Response.json({ models: models.map((name) => ({ name })) });
    return Response.json({ version: "0.12.0" });
  }) as typeof fetch;
}

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "alden-choices-"));
  process.env.ALDEN_HOME = home;
});
afterEach(async () => {
  delete process.env.ALDEN_HOME;
  await rm(home, { recursive: true, force: true });
});

const deps = (over: Partial<ModelChoicesDeps> = {}): ModelChoicesDeps => ({
  cwd: home,
  env: {},
  store: store(),
  openaiStore: store(),
  profileDir: join(home, "none"),
  fetch: ollama(null),
  ...over,
});

describe("modelChoices", () => {
  it("groups Anthropic, OpenAI and Ollama, each available only when it's set up here", async () => {
    const none = await modelChoices(deps());
    expect(none.current).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(none.groups.map((g) => [g.provider, g.label, g.via, g.available])).toEqual([
      ["anthropic", "Anthropic", "your key", false],
      ["openai", "OpenAI", "your key", false],
      ["ollama", "Local", "Ollama", false],
    ]);
    expect(none.groups[0]?.items[0]).toEqual({ id: "claude-sonnet-5", note: "fast" });
    expect(none.groups[1]?.items.map((m) => m.id)).toEqual(["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"]);
    expect(none.groups[2]?.items).toEqual([]);

    const all = await modelChoices(
      deps({
        env: { ANTHROPIC_API_KEY: "x" },
        openaiStore: store("sk-proj-stored"),
        fetch: ollama(["qwen3-coder:30b"]),
      }),
    );
    expect(all.groups.map((g) => g.available)).toEqual([true, true, true]);
    expect(all.groups[2]?.items).toEqual([{ id: "qwen3-coder:30b", note: "offline" }]);
    expect(JSON.stringify(all)).not.toContain("sk-proj");
  });

  it("names Ollama as the provider for a local model, and lists a model in use that isn't on the list", async () => {
    await writeFile(userConfigPath(), 'model = { provider = "openai-compatible", name = "llama3:8b" }\n');
    const local = await modelChoices(deps({ fetch: ollama([]) }));
    expect(local.current).toEqual({ provider: "ollama", model: "llama3:8b" });
    expect(local.groups[2]?.items).toEqual([{ id: "llama3:8b", note: "in use" }]);

    await writeFile(
      userConfigPath(),
      'model = { provider = "openai-compatible", name = "m", baseUrl = "http://localhost:1234/v1" }\n',
    );
    expect((await modelChoices(deps())).current.provider).toBe("openai-compatible");
  });

  it("adds the configured cloud platform as its own group", async () => {
    await writeFile(userConfigPath(), 'model = { provider = "bedrock", name = "opus" }\n');
    const bedrock = await modelChoices(deps());
    expect(bedrock.current).toEqual({ provider: "bedrock", model: "claude-opus-5" });
    expect(bedrock.groups.at(-1)).toMatchObject({ provider: "bedrock", via: "AWS", available: true });
  });
});

describe("pickModel", () => {
  it("sets the provider and model in your config, and answers with the new choices", async () => {
    const keys = deps({ env: { ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y" } });
    const openai = await pickModel({ provider: "openai", model: "gpt-6-astra" }, keys);
    expect(openai.current).toEqual({ provider: "openai", model: "gpt-6-astra" });
    expect((await loadConfig(home)).model).toMatchObject({ provider: "openai", name: "gpt-6-astra" });

    const claude = await pickModel({ provider: "anthropic", model: "claude-opus-5-5" }, keys);
    expect(claude.current).toEqual({ provider: "anthropic", model: "claude-opus-5-5" });
  });

  it("uses a pulled Ollama model", async () => {
    const picked = await pickModel(
      { provider: "ollama", model: "qwen3-coder:30b" },
      deps({ fetch: ollama(["qwen3-coder:30b"]) }),
    );
    expect(picked.current).toEqual({ provider: "ollama", model: "qwen3-coder:30b" });
    expect((await loadConfig(home)).model).toMatchObject({ provider: "openai-compatible", name: "qwen3-coder:30b" });
  });

  it("refuses a provider that isn't set up, a model Ollama hasn't pulled, and names that aren't models", async () => {
    const refused = (pick: Parameters<typeof pickModel>[0], d = deps()) =>
      pickModel(pick, d).then(
        () => "picked",
        (e: ModelPickError) => `${e.kind}: ${e.message}`,
      );
    expect(await refused({ provider: "openai", model: "gpt-6-astra" })).toMatch(/^unavailable: No OpenAI API key/);
    expect(
      await refused({ provider: "anthropic", model: "gpt-6-astra" }, deps({ env: { ANTHROPIC_API_KEY: "x" } })),
    ).toMatch(/^invalid/);
    expect(
      await refused({ provider: "ollama", model: "llama3:8b" }, deps({ fetch: ollama(["qwen3-coder:30b"]) })),
    ).toMatch(/^invalid: Ollama hasn't pulled/);
    expect(await refused({ provider: "openai", model: "../../etc" }, deps({ env: { OPENAI_API_KEY: "y" } }))).toMatch(
      /^invalid/,
    );
    expect((await loadConfig(home)).model.provider).toBe("anthropic");
  });
});
