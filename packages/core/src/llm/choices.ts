import type { AldenConfig, ModelChoice, ModelChoices, ModelGroup, ModelPick } from "@alden/schema";
import { loadConfig, readToml, setConfigValue, unsetConfigValue, userConfigPath } from "../config.js";
import { type ModelKeyDeps, resolveModelKey, resolveOpenAIKey } from "./key.js";
import { detectOllama, isLocalModelName, ollamaUrl, useLocalModel } from "./local.js";
import { resolveModel } from "./models.js";
import { DEFAULT_OPENAI_MODEL } from "./openai.js";
import { DEFAULT_BASE_URL } from "./openai-compatible.js";
import { useAnthropic } from "./setup.js";

/**
 * The Claude models the picker offers, best known first after the default. Any other Claude ID still works by hand
 * (`alden config set model.name …`); the one in use is always listed.
 */
export const ANTHROPIC_PICKS: readonly ModelChoice[] = [
  { id: "claude-sonnet-5", note: "fast" },
  { id: "claude-opus-5-5", note: "deep" },
  { id: "claude-fable-5-1", note: "deepest" },
  { id: "claude-haiku-4-5", note: "cheap" },
];

/** OpenAI's current flagship models (developers.openai.com/api/docs/models, checked 12 October 2026). */
export const OPENAI_PICKS: readonly ModelChoice[] = [
  { id: "gpt-6.1-sol", note: "fast" },
  { id: "gpt-6-astra", note: "deepest" },
  { id: "gpt-6-luna", note: "cheap" },
];

const PLATFORM_VIA = { bedrock: "AWS", vertex: "Google Cloud", foundry: "Azure" } as const;

/** Model IDs as providers take them: letters, digits and . _ : - / (fine-tunes, snapshots), nothing else. */
const MODEL_ID = /^\w[\w.:/-]{0,199}$/;

/** Why a pick can't be made: the provider isn't set up (409), or the model name isn't one (400). */
export class ModelPickError extends Error {
  constructor(
    readonly kind: "unavailable" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "ModelPickError";
  }
}

export interface ModelChoicesDeps extends ModelKeyDeps {
  cwd?: string;
  fetch?: typeof fetch;
}

/** Whether an openai-compatible endpoint is Ollama's (the default address, or the one OLLAMA_HOST names). */
function isOllama(config: AldenConfig, env: NodeJS.ProcessEnv): boolean {
  const base = config.model.baseUrl?.replace(/\/+$/, "");
  return base === undefined || base === DEFAULT_BASE_URL || base === `${ollamaUrl(env)}/v1`;
}

/** The model reviews use now, in the picker's terms. */
function currentOf(config: AldenConfig, env: NodeJS.ProcessEnv): ModelChoices["current"] {
  const name = resolveModel(config.model.name);
  switch (config.model.provider) {
    case "openai":
      return { provider: "openai", model: name.startsWith("claude-") ? DEFAULT_OPENAI_MODEL : name };
    case "openai-compatible":
      return { provider: isOllama(config, env) ? "ollama" : "openai-compatible", model: config.model.name };
    default:
      return { provider: config.model.provider, model: name };
  }
}

/** The group's models, with the one in use added when it isn't on the list. */
function withCurrent(items: readonly ModelChoice[], current: ModelChoices["current"], provider: string): ModelChoice[] {
  const list = [...items];
  if (current.provider === provider && !list.some((m) => m.id === current.model)) {
    list.unshift({ id: current.model, note: "in use" });
  }
  return list;
}

/**
 * What the model picker shows (`GET /api/models`): the model in use, and every provider Alden can reach, each
 * `available` only when it's set up here: an Anthropic or OpenAI key found (environment first, then the stored key),
 * Ollama running with a model pulled (it lists those), or Bedrock, Vertex or Foundry configured as the provider.
 */
export async function modelChoices(deps: ModelChoicesDeps = {}): Promise<ModelChoices> {
  const env = deps.env ?? process.env;
  const config = await loadConfig(deps.cwd);
  const current = currentOf(config, env);
  const [anthropicKey, openaiKey, ollama] = await Promise.all([
    resolveModelKey(deps),
    resolveOpenAIKey(deps),
    detectOllama(ollamaUrl(env), deps.fetch ?? fetch),
  ]);
  const groups: ModelGroup[] = [
    {
      provider: "anthropic",
      label: "Anthropic",
      via: "your key",
      available: anthropicKey !== undefined,
      items: withCurrent(ANTHROPIC_PICKS, current, "anthropic"),
    },
    {
      provider: "openai",
      label: "OpenAI",
      via: "your key",
      available: openaiKey !== undefined,
      items: withCurrent(OPENAI_PICKS, current, "openai"),
    },
    {
      provider: "ollama",
      label: "Local",
      via: "Ollama",
      available: ollama.reachable && ollama.models.length > 0,
      items: withCurrent(
        ollama.models.map((m) => ({ id: m.name, note: "offline" })),
        current,
        "ollama",
      ),
    },
  ];
  const platform = config.model.provider;
  if (platform === "bedrock" || platform === "vertex" || platform === "foundry") {
    groups.push({
      provider: platform,
      label: "Anthropic",
      via: PLATFORM_VIA[platform],
      available: true,
      items: withCurrent(ANTHROPIC_PICKS, current, platform),
    });
  }
  return { current, groups };
}

/**
 * Makes a model from the picker the one reviews use (`PUT /api/models`), in your user config: `model.provider` and
 * `model.name` (Ollama writes `model.baseUrl` only when it isn't at its default address). Refuses a provider that
 * isn't set up, so the picker never leaves you with a model that can't run.
 */
export async function pickModel(pick: ModelPick, deps: ModelChoicesDeps = {}): Promise<ModelChoices> {
  const model = pick.model.trim();
  if (!MODEL_ID.test(model) || model.includes(".."))
    throw new ModelPickError("invalid", `"${model}" isn't a model name.`);
  const before = await modelChoices(deps);
  const group = before.groups.find((g) => g.provider === pick.provider);
  if (!group?.available) {
    const why: Record<string, string> = {
      anthropic: "No Anthropic API key found. Add one in Settings (or set ANTHROPIC_API_KEY).",
      openai: "No OpenAI API key found. Add one in Settings (or set OPENAI_API_KEY).",
      ollama: "Ollama isn't running here, or has no model pulled. Set up a local model first.",
    };
    throw new ModelPickError(
      "unavailable",
      why[pick.provider] ?? `${pick.provider} isn't the provider set up here. Set it with alden config.`,
    );
  }
  switch (pick.provider) {
    case "anthropic":
      if (!resolveModel(model).startsWith("claude-")) {
        throw new ModelPickError("invalid", `${model} isn't a Claude model.`);
      }
      await useAnthropic();
      await setConfigValue("model.name", model);
      break;
    case "openai": {
      const user = await readToml(userConfigPath());
      const was = ((user.model ?? {}) as { provider?: unknown }).provider;
      await setConfigValue("model.provider", "openai");
      await setConfigValue("model.name", model);
      if (was === "openai-compatible") await unsetConfigValue("model.baseUrl");
      break;
    }
    case "ollama":
      if (!isLocalModelName(model) || !group.items.some((m) => m.id === model)) {
        throw new ModelPickError("invalid", `Ollama hasn't pulled ${model}. Set up a local model to download it.`);
      }
      await useLocalModel(model, ollamaUrl(deps.env ?? process.env));
      break;
    default:
      await setConfigValue("model.name", model);
  }
  return modelChoices(deps);
}
