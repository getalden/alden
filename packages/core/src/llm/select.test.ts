import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AldenConfigSchema } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CredentialStore } from "../github/credentials.js";
import { selectProvider } from "./select.js";

/** A keychain that has nothing, so no test ever reads the real one. */
const noKey: CredentialStore = { get: async () => undefined, set: async () => {}, delete: async () => {} };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alden-select-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("selectProvider", () => {
  const config = AldenConfigSchema.parse({});

  it("uses the configured model, or a one-off override", async () => {
    const deps = { env: { ANTHROPIC_API_KEY: "k", XDG_CONFIG_HOME: dir }, store: noKey };
    const chosen = await selectProvider(config, undefined, deps);
    expect(chosen.ok && chosen.provider.model).toBe("claude-sonnet-5");
    expect(chosen.ok && chosen.key).toEqual({ source: "env", where: "ANTHROPIC_API_KEY" });
    const override = await selectProvider(config, "opus", deps);
    expect(override.ok && override.provider.model).toBe("claude-opus-5");
  });

  it("uses the key stored with alden auth model", async () => {
    const stored: CredentialStore = { ...noKey, get: async () => "sk-ant-api03-stored" };
    const chosen = await selectProvider(config, undefined, {
      env: {},
      store: stored,
      profileDir: join(dir, "none"),
    });
    expect(chosen.ok && chosen.key?.source).toBe("alden");
  });

  it("explains a missing key", async () => {
    const chosen = await selectProvider(config, undefined, { env: {}, store: noKey, profileDir: join(dir, "none") });
    expect(chosen).toEqual({
      ok: false,
      reason: expect.stringMatching(/No Anthropic API key found.*alden auth model.*--no-llm/),
    });
  });

  it("won't send a Claude model name to a local server", async () => {
    const local = AldenConfigSchema.parse({ model: { provider: "openai-compatible" } });
    expect(await selectProvider(local, undefined, { env: {}, store: noKey })).toEqual({
      ok: false,
      reason: expect.stringMatching(/model\.name is a Claude model \(claude-sonnet-5\).*alden config set model\.name/),
    });
  });

  it("uses an OpenAI-compatible server for local models, defaulting to Ollama", async () => {
    const local = AldenConfigSchema.parse({ model: { provider: "openai-compatible", name: "qwen3-coder:30b" } });
    const chosen = await selectProvider(local, undefined, { env: {}, store: noKey });
    expect(chosen.ok && [chosen.provider.provider, chosen.provider.model]).toEqual([
      "openai-compatible",
      "qwen3-coder:30b",
    ]);
  });

  it("uses Claude on Bedrock, Vertex or Foundry with each platform's model ID", async () => {
    const on = async (provider: string) => {
      const chosen = await selectProvider(
        AldenConfigSchema.parse({ model: { provider, region: "us-east-1" } }),
        undefined,
        { env: {}, store: noKey },
      );
      return chosen.ok ? [chosen.provider.provider, chosen.provider.model] : chosen.reason;
    };
    expect(await on("bedrock")).toEqual(["bedrock", "anthropic.claude-sonnet-5"]);
    expect(await on("vertex")).toEqual(["vertex", "claude-sonnet-5"]);
    expect(await on("foundry")).toEqual(["foundry", "claude-sonnet-5"]);
  });

  it("uses OpenAI with your OpenAI key, OpenAI's default model in place of a Claude alias, and says where the key is", async () => {
    const openai = AldenConfigSchema.parse({ model: { provider: "openai" } });
    const stored: CredentialStore = { ...noKey, get: async () => "sk-proj-stored" };
    const chosen = await selectProvider(openai, undefined, { env: {}, store: noKey, openaiStore: stored });
    expect(chosen.ok && [chosen.provider.provider, chosen.provider.model]).toEqual(["openai", "gpt-6.1-sol"]);
    expect(chosen.ok && chosen.key).toEqual({
      source: "alden",
      where: "the OpenAI key you stored with `alden auth model`",
    });
    expect(JSON.stringify(chosen.ok && chosen.key)).not.toContain("sk-proj");
    const astra = await selectProvider(openai, "gpt-6-astra", { env: { OPENAI_API_KEY: "k" }, openaiStore: noKey });
    expect(astra.ok && astra.provider.model).toBe("gpt-6-astra");
    expect(await selectProvider(openai, undefined, { env: {}, openaiStore: noKey })).toEqual({
      ok: false,
      reason: expect.stringMatching(/No OpenAI API key found.*OPENAI_API_KEY/),
    });
  });
});
