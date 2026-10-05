import { totalmem } from "node:os";
import type { KeyTestResult, ModelSetupState } from "@alden/schema";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig, readToml, setConfigValue, unsetConfigValue, userConfigPath } from "../config.js";
import { checkModelKey, type ModelKeyDeps, modelKeyStore, resolveModelKey } from "./key.js";
import { detectOllama, ollamaUrl, recommendLocalModel } from "./local.js";
import { resolveModel } from "./models.js";
import { selectProvider } from "./select.js";

/** Where people create an Anthropic API key, and where the hosted Alden's waitlist is. Shown by every surface. */
export const ANTHROPIC_KEYS_URL = "https://console.anthropic.com/settings/keys";
export const ALDEN_CLOUD_URL = "https://getalden.dev/cloud";
export const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";

/** The smallest, cheapest Claude model: testing a key asks it for one token. */
export const KEY_TEST_MODEL = "claude-haiku-4-5";

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
    return { ok: true, key: null };
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
    return { ok: true, key: null };
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
 * Makes Claude the model: if your user config names another provider (a local model, Bedrock…), it goes back to
 * Anthropic, and a model name that isn't Claude's goes back to the default.
 */
export async function useAnthropic(): Promise<void> {
  const user = await readToml(userConfigPath());
  const model = (user.model ?? {}) as { provider?: unknown; name?: unknown };
  if (model.provider !== undefined && model.provider !== "anthropic")
    await setConfigValue("model.provider", "anthropic");
  if (typeof model.name === "string" && !resolveModel(model.name).startsWith("claude-")) {
    await unsetConfigValue("model.name");
  }
}

export interface KeySetupDeps extends ModelKeyDeps {
  client?: KeyTestClient;
  /** Skip the test request: storing a key whose check couldn't run (no network) when the person says so. */
  untested?: boolean;
}

/**
 * Tests a key, and if it works stores it (keychain, or a 0600 file without one) and makes Claude the model. Never
 * stores a key Anthropic refused. The answer says where Alden now gets its key, never the key.
 */
export async function setUpModelKey(key: string, deps: KeySetupDeps = {}): Promise<KeyTestResult> {
  const trimmed = key.trim();
  const shape = checkModelKey(trimmed);
  if (shape) return { ok: false, reason: "shape", message: shape };
  const tested = deps.untested ? ({ ok: true, key: null } as const) : await testModelKey(trimmed, deps.client);
  if (!tested.ok) return tested;
  await (deps.store ?? modelKeyStore()).set(trimmed);
  await useAnthropic();
  const now = await resolveModelKey(deps);
  return { ok: true, key: now ? { source: now.source, where: now.where } : null };
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
    choice.ok && choice.key
      ? choice.key
      : config.model.provider === "anthropic"
        ? undefined
        : await resolveModelKey(deps);
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
    ollama,
    memoryGb,
    recommendation: recommendLocalModel(memoryGb, ollama.models),
  };
}
