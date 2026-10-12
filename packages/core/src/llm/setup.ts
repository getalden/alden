import { totalmem } from "node:os";
import type { KeyTestResult, ModelSetupState } from "@alden/schema";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig, readToml, setConfigValue, unsetConfigValue, userConfigPath } from "../config.js";
import {
  checkModelKey,
  detectKeyKind,
  type KeyProvider,
  type ModelKeyDeps,
  modelKeyStore,
  OPENAI_KEYS_URL,
  resolveModelKey,
  resolveOpenAIKey,
} from "./key.js";
import { detectOllama, ollamaUrl, recommendLocalModel } from "./local.js";
import { resolveModel } from "./models.js";
import { DEFAULT_OPENAI_MODEL, isOpenAiModel, OPENAI_BASE_URL } from "./openai.js";
import { selectProvider } from "./select.js";

/** Where people create an Anthropic API key, and where the hosted Alden's waitlist is. Shown by every surface. */
export const ANTHROPIC_KEYS_URL = "https://console.anthropic.com/settings/keys";
export const ALDEN_CLOUD_URL = "https://getalden.dev/cloud";
export const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";

/** The smallest, cheapest Claude model: testing a key asks it for one token. */
export const KEY_TEST_MODEL = "claude-haiku-4-5";

/** OpenAI's cheapest current model ($0.10 per million input tokens): testing a key asks it for a few tokens. */
export const OPENAI_KEY_TEST_MODEL = "gpt-6-luna";

/** The one call testing a key makes. Tests pass a fake; the real one is the SDK with no retries. */
export type KeyTestClient = (apiKey: string) => {
  messages: {
    create(body: {
      model: string;
      max_tokens: number;
      messages: { role: "user"; content: string }[];
    }): Promise<unknown>;
  };
};

const sdkClient: KeyTestClient = (apiKey) => new Anthropic({ apiKey, maxRetries: 0, timeout: 20_000 });

/**
 * Whether `key` works: one tiny real request (Haiku, one token out, a fraction of a cent), made only when someone asks
 * for it. Says why not in words a person can act on: a mistyped or deleted key, no credit, no network.
 */
export async function testModelKey(key: string, client: KeyTestClient = sdkClient): Promise<KeyTestResult> {
  const trimmed = key.trim();
  const shape = checkModelKey(trimmed);
  if (shape) return { ok: false, reason: "shape", message: shape };
  try {
    await client(trimmed).messages.create({
      model: KEY_TEST_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "Hi" }],
    });
    return { ok: true, provider: "anthropic", key: null };
  } catch (error) {
    return keyTestFailure(error);
  }
}

function keyTestFailure(error: unknown): KeyTestResult {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Anthropic.AuthenticationError) {
    return {
      ok: false,
      reason: "invalid",
      message: `Anthropic didn't accept that key: it may be mistyped, or deleted. Create a new one at ${ANTHROPIC_KEYS_URL}.`,
    };
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return {
      ok: false,
      reason: "permission",
      message: "Anthropic accepted the key but won't let it use the Messages API. Check its workspace in the Console.",
    };
  }
  // Signed in, just busy, or without access to Haiku: the key itself works.
  if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.NotFoundError) {
    return { ok: true, provider: "anthropic", key: null };
  }
  if (error instanceof Anthropic.BadRequestError && /credit balance|billing|purchase credits/i.test(message)) {
    return {
      ok: false,
      reason: "billing",
      message:
        "The key works, but its account has no credit. Add credit at https://console.anthropic.com/settings/billing, then try again.",
    };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return {
      ok: false,
      reason: "network",
      message: "Couldn't reach api.anthropic.com to check the key. Check your connection (or proxy), then try again.",
    };
  }
  if (error instanceof Anthropic.APIError && (error.status === 529 || (error.status ?? 0) >= 500)) {
    return {
      ok: false,
      reason: "unavailable",
      message: "Anthropic is busy or having trouble, so the key couldn't be checked. Try again in a minute.",
    };
  }
  return { ok: false, reason: "other", message: `Anthropic answered: ${message.slice(0, 200)}` };
}

/**
 * Whether an OpenAI key works: one tiny Chat Completions request to the cheapest model (a few output tokens, far less
 * than a cent), made only when someone asks. `doFetch` is faked in tests.
 */
export async function testOpenAIKey(key: string, doFetch: typeof fetch = fetch): Promise<KeyTestResult> {
  const trimmed = key.trim();
  const detected = detectKeyKind(trimmed);
  if (!detected.ok) return { ok: false, reason: "shape", message: detected.message };
  if (detected.provider !== "openai") {
    return { ok: false, reason: "shape", message: "That's an Anthropic key, not an OpenAI one." };
  }
  let response: Response;
  try {
    response = await doFetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${trimmed}` },
      body: JSON.stringify({
        model: OPENAI_KEY_TEST_MODEL,
        max_completion_tokens: 16,
        messages: [{ role: "user", content: "Hi" }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return {
      ok: false,
      reason: "network",
      message: "Couldn't reach api.openai.com to check the key. Check your connection (or proxy), then try again.",
    };
  }
  if (response.ok) return { ok: true, provider: "openai", key: null };
  const text = await response.text().catch(() => "");
  let code = "";
  let message = text.slice(0, 200);
  try {
    const error = (JSON.parse(text) as { error?: { code?: string; message?: string } }).error;
    code = error?.code ?? "";
    message = error?.message?.slice(0, 200) ?? message;
  } catch {
    // Not JSON: keep the text.
  }
  if (response.status === 401) {
    return {
      ok: false,
      reason: "invalid",
      message: `OpenAI didn't accept that key: it may be mistyped, or deleted. Create a new one at ${OPENAI_KEYS_URL}.`,
    };
  }
  if (response.status === 429 && code === "insufficient_quota") {
    return {
      ok: false,
      reason: "billing",
      message:
        "The key works, but its account has no credit. Add credit at https://platform.openai.com/settings/organization/billing, then try again.",
    };
  }
  if (response.status === 403) {
    return {
      ok: false,
      reason: "permission",
      message:
        "OpenAI accepted the key but won't let it use Chat Completions. Give the key the Model capabilities permission (or All) in its project.",
    };
  }
  // Signed in, just busy, or without access to the test model: the key itself works.
  if (response.status === 429 || response.status === 404 || response.status === 400) {
    return { ok: true, provider: "openai", key: null };
  }
  if (response.status >= 500) {
    return {
      ok: false,
      reason: "unavailable",
      message: "OpenAI is busy or having trouble, so the key couldn't be checked. Try again in a minute.",
    };
  }
  return { ok: false, reason: "other", message: `OpenAI answered ${response.status}: ${message}` };
}

/**
 * Makes an OpenAI model the model: the provider becomes openai, and a model name that isn't OpenAI's becomes the
 * default (gpt-6.1-sol).
 */
export async function useOpenAI(): Promise<void> {
  const user = await readToml(userConfigPath());
  const model = (user.model ?? {}) as { provider?: unknown; name?: unknown };
  if (model.provider !== "openai") await setConfigValue("model.provider", "openai");
  if (typeof model.name !== "string" || !isOpenAiModel(resolveModel(model.name))) {
    await setConfigValue("model.name", DEFAULT_OPENAI_MODEL);
  }
  // Ollama's address isn't OpenAI's.
  if (model.provider === "openai-compatible") await unsetConfigValue("model.baseUrl");
}

/**
 * Makes Claude the model: if your user config names another provider (a local model, Bedrock…), it goes back to
 * Anthropic, and a model name that isn't Claude's goes back to the default.
 */
export async function useAnthropic(): Promise<void> {
  const user = await readToml(userConfigPath());
  const model = (user.model ?? {}) as { provider?: unknown; name?: unknown };
  if (model.provider !== undefined && model.provider !== "anthropic")
    await setConfigValue("model.provider", "anthropic");
  if (model.provider === "openai-compatible" || model.provider === "openai") await unsetConfigValue("model.baseUrl");
  if (typeof model.name === "string" && !resolveModel(model.name).startsWith("claude-")) {
    await unsetConfigValue("model.name");
  }
}

export interface KeySetupDeps extends ModelKeyDeps {
  client?: KeyTestClient;
  /** For testing an OpenAI key; fetch by default. */
  openaiFetch?: typeof fetch;
  /** Skip the test request: storing a key whose check couldn't run (no network) when the person says so. */
  untested?: boolean;
}

/**
 * Tests a key, Anthropic's or OpenAI's (told apart by its shape), and if it works stores it under its provider's name
 * (keychain, or a 0600 file without one) and makes that provider the model. Never stores a key the provider refused.
 * The answer says whose key it was and where Alden now gets that provider's key, never the key.
 */
export async function setUpModelKey(key: string, deps: KeySetupDeps = {}): Promise<KeyTestResult> {
  const trimmed = key.trim();
  const detected = detectKeyKind(trimmed);
  if (!detected.ok) return { ok: false, reason: "shape", message: detected.message };
  const provider: KeyProvider = detected.provider;
  const tested = deps.untested
    ? ({ ok: true, key: null } as const)
    : provider === "openai"
      ? await testOpenAIKey(trimmed, deps.openaiFetch)
      : await testModelKey(trimmed, deps.client);
  if (!tested.ok) return tested;
  if (provider === "openai") {
    await (deps.openaiStore ?? modelKeyStore("openai")).set(trimmed);
    await useOpenAI();
    const now = await resolveOpenAIKey(deps);
    return { ok: true, provider, key: now ? { source: now.source, where: now.where } : null };
  }
  await (deps.store ?? modelKeyStore()).set(trimmed);
  await useAnthropic();
  const now = await resolveModelKey(deps);
  return { ok: true, provider, key: now ? { source: now.source, where: now.where } : null };
}

export interface SetupStateDeps extends ModelKeyDeps {
  cwd?: string;
  fetch?: typeof fetch;
  /** Bytes of memory; os.totalmem() by default. */
  totalMemory?: number;
}

/**
 * What a "Set up a model" step needs to know, for every surface: what reviews use now, any Anthropic credentials (in
 * Alden's order), whether Ollama runs here and what it has pulled, and the local model to suggest for this machine.
 */
export async function modelSetupState(deps: SetupStateDeps = {}): Promise<ModelSetupState> {
  const config = await loadConfig(deps.cwd);
  const choice = await selectProvider(config, undefined, deps);
  // selectProvider looks up the key only for Anthropic; otherwise look here, without asking the keychain twice.
  const key =
    config.model.provider === "anthropic" ? (choice.ok ? choice.key : undefined) : await resolveModelKey(deps);
  const openaiKey = config.model.provider === "openai" && choice.ok ? choice.key : await resolveOpenAIKey(deps);
  const ollama = await detectOllama(ollamaUrl(deps.env ?? process.env), deps.fetch ?? fetch);
  const memoryGb = Math.round((deps.totalMemory ?? totalmem()) / 1024 ** 3);
  return {
    current: {
      provider: config.model.provider,
      model: resolveModel(config.model.name),
      available: choice.ok,
      reason: choice.ok ? null : choice.reason,
    },
    key: key ? { source: key.source, where: key.where } : null,
    openaiKey: openaiKey ? { source: openaiKey.source, where: openaiKey.where } : null,
    ollama,
    memoryGb,
    recommendation: recommendLocalModel(memoryGb, ollama.models),
  };
}
