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

  it("says which providers aren't supported yet", () => {
    const local = AldenConfigSchema.parse({ model: { provider: "openai-compatible", name: "llama3" } });
    expect(selectProvider(local, undefined, {})).toEqual({
      ok: false,
      reason: expect.stringMatching(/openai-compatible provider isn't supported yet/),
    });
  });
});
