import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AldenConfig } from "@alden/schema";
import { AnthropicProvider } from "./anthropic.js";
import { resolveModel } from "./models.js";
import { DEFAULT_BASE_URL, OpenAICompatibleProvider } from "./openai-compatible.js";
import { createPlatformClient, platformModelId } from "./platforms.js";
import type { LlmProvider } from "./provider.js";

export type ProviderChoice = { ok: true; provider: LlmProvider } | { ok: false; reason: string };

/**
 * Whether the Anthropic SDK will find credentials, without calling anything: an API key or auth token, workload
 * identity federation, or an `ant auth login` profile. (Claude.ai subscription logins are never used.)
 */
export function hasAnthropicCredentials(
  env: NodeJS.ProcessEnv = process.env,
  profileDir: string = join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "anthropic"),
): boolean {
  if (env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim() || env.ANTHROPIC_PROFILE?.trim()) return true;
  if (env.ANTHROPIC_FEDERATION_RULE_ID && (env.ANTHROPIC_IDENTITY_TOKEN || env.ANTHROPIC_IDENTITY_TOKEN_FILE))
    return true;
  return existsSync(profileDir);
}

/** The provider the config asks for, or why there isn't one. `modelOverride` is a one-off `--model`. */
export function selectProvider(
  config: AldenConfig,
  modelOverride?: string,
  env: NodeJS.ProcessEnv = process.env,
): ProviderChoice {
  const model = modelOverride ?? config.model.name;
  switch (config.model.provider) {
    case "anthropic":
      if (!hasAnthropicCredentials(env)) {
        return {
          ok: false,
          reason:
            "No Anthropic API key found, so only the checks ran. Set ANTHROPIC_API_KEY (or run `ant auth login`) to add the model's view, or pass --no-llm to hide this.",
        };
      }
      return { ok: true, provider: new AnthropicProvider(model) };
    case "bedrock":
    case "vertex":
    case "foundry": {
      const platform = config.model.provider;
      // Credentials come from AWS, GCP or Azure; a failure shows up as the model's status rather than here.
      return {
        ok: true,
        provider: new AnthropicProvider(
          platformModelId(platform, resolveModel(model)),
          () => createPlatformClient(platform, config.model),
          platform,
        ),
      };
    }
    case "openai-compatible":
      // The default model name is a Claude alias, which means nothing to Ollama or LM Studio.
      if (resolveModel(model).startsWith("claude-")) {
        return {
          ok: false,
          reason: `model.name is a Claude model (${resolveModel(model)}), but the provider is openai-compatible. Set your local model, e.g. \`alden config set model.name qwen3-coder:30b\`.`,
        };
      }
      return { ok: true, provider: new OpenAICompatibleProvider(model, config.model.baseUrl ?? DEFAULT_BASE_URL) };
  }
}
