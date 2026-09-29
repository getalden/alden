import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AldenConfigSchema } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasAnthropicCredentials, selectProvider } from "./select.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alden-select-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("hasAnthropicCredentials", () => {
  const missing = () => join(dir, "no-profiles");

  it("finds keys, tokens, profiles and workload identity", () => {
    expect(hasAnthropicCredentials({ ANTHROPIC_API_KEY: "k" }, missing())).toBe(true);
    expect(hasAnthropicCredentials({ ANTHROPIC_AUTH_TOKEN: "t" }, missing())).toBe(true);
    expect(
      hasAnthropicCredentials({ ANTHROPIC_FEDERATION_RULE_ID: "r", ANTHROPIC_IDENTITY_TOKEN_FILE: "/f" }, missing()),
    ).toBe(true);
    expect(hasAnthropicCredentials({}, dir)).toBe(true); // an `ant auth login` profile directory
  });

  it("finds nothing in an empty environment, or with a blank key", () => {
    expect(hasAnthropicCredentials({}, missing())).toBe(false);
    expect(hasAnthropicCredentials({ ANTHROPIC_API_KEY: "  " }, missing())).toBe(false);
  });
});

describe("selectProvider", () => {
  const config = AldenConfigSchema.parse({});

  it("uses the configured model, or a one-off override", () => {
    const env = { ANTHROPIC_API_KEY: "k", XDG_CONFIG_HOME: dir };
    const chosen = selectProvider(config, undefined, env);
    expect(chosen.ok && chosen.provider.model).toBe("claude-sonnet-5");
    const override = selectProvider(config, "opus", env);
    expect(override.ok && override.provider.model).toBe("claude-opus-5");
  });

  it("explains a missing key", () => {
    const chosen = selectProvider(config, undefined, { XDG_CONFIG_HOME: join(dir, "none") });
    expect(chosen).toEqual({ ok: false, reason: expect.stringMatching(/No Anthropic API key found.*--no-llm/) });
  });

  it("won't send a Claude model name to a local server", () => {
    const local = AldenConfigSchema.parse({ model: { provider: "openai-compatible" } });
    expect(selectProvider(local, undefined, {})).toEqual({
      ok: false,
      reason: expect.stringMatching(/model\.name is a Claude model \(claude-sonnet-5\).*alden config set model\.name/),
    });
  });

  it("uses an OpenAI-compatible server for local models, defaulting to Ollama", () => {
    const local = AldenConfigSchema.parse({ model: { provider: "openai-compatible", name: "qwen3-coder:30b" } });
    const chosen = selectProvider(local, undefined, {});
    expect(chosen.ok && [chosen.provider.provider, chosen.provider.model]).toEqual([
      "openai-compatible",
      "qwen3-coder:30b",
    ]);
  });

  it("uses Claude on Bedrock, Vertex or Foundry with each platform's model ID", () => {
    const on = (provider: string) => {
      const chosen = selectProvider(
        AldenConfigSchema.parse({ model: { provider, region: "us-east-1" } }),
        undefined,
        {},
      );
      return chosen.ok ? [chosen.provider.provider, chosen.provider.model] : chosen.reason;
    };
    expect(on("bedrock")).toEqual(["bedrock", "anthropic.claude-sonnet-5"]);
    expect(on("vertex")).toEqual(["vertex", "claude-sonnet-5"]);
    expect(on("foundry")).toEqual(["foundry", "claude-sonnet-5"]);
  });
});
