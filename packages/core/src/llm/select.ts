import type { AldenConfig } from "@alden/schema";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider } from "./anthropic.js";
import { type ModelKey, type ModelKeyDeps, resolveModelKey, resolveOpenAIKey } from "./key.js";
import { resolveModel } from "./models.js";
import { DEFAULT_OPENAI_MODEL, OPENAI_BASE_URL, OpenAIProvider } from "./openai.js";
import { DEFAULT_BASE_URL, OpenAICompatibleProvider } from "./openai-compatible.js";
import { createPlatformClient, platformModelId } from "./platforms.js";
import type { LlmProvider } from "./provider.js";

/** The provider, and for Anthropic and OpenAI where its key comes from (never the key); or why there isn't one. */
export type ProviderChoice = { ok: true; provider: LlmProvider; key?: ModelKey } | { ok: false; reason: string };

/**
 * The provider the config asks for, or why there isn't one. `modelOverride` is a one-off `--model`. For Anthropic, the
 * key comes from `resolveModelKey` (the environment, then the key `alden auth model` stored, then the ant CLI).
 */
export async function selectProvider(
  config: AldenConfig,
  modelOverride?: string,
  deps: ModelKeyDeps = {},
): Promise<ProviderChoice> {
  const model = modelOverride ?? config.model.name;
  switch (config.model.provider) {
    case "anthropic": {
      const key = await resolveModelKey(deps);
      if (!key) {
        return {
          ok: false,
          reason:
            "No Anthropic API key found, so only the checks ran. Run `alden auth model` (or set ANTHROPIC_API_KEY) to add the model's view, or pass --no-llm to hide this.",
        };
      }
      const { apiKey } = key;
      return {
        ok: true,
        // The SDK finds environment and profile credentials itself; a stored key is handed over.
        provider: apiKey
          ? new AnthropicProvider(model, () => Promise.resolve(new Anthropic({ apiKey })))
          : new AnthropicProvider(model),
        key,
      };
    }
    case "openai": {
      const key = await resolveOpenAIKey(deps);
      if (!key?.apiKey) {
        return {
          ok: false,
          reason:
            "No OpenAI API key found, so only the checks ran. Run `alden auth model` (or set OPENAI_API_KEY) to add the model's view, or pass --no-llm to hide this.",
        };
      }
      // The default model name is a Claude alias: with OpenAI that means OpenAI's default.
      const name = resolveModel(model).startsWith("claude-") ? DEFAULT_OPENAI_MODEL : resolveModel(model);
      return {
        ok: true,
        provider: new OpenAIProvider(name, key.apiKey, config.model.baseUrl ?? OPENAI_BASE_URL),
        key: { source: key.source, where: key.where },
      };
    }
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
