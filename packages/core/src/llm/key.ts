import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type CredentialStore, DefaultCredentialStore } from "../github/credentials.js";

/** Where the Anthropic credentials come from: the environment, the key `alden auth model` stored, or the ant CLI. */
export type ModelKeySource = "env" | "alden" | "ant";

export interface ModelKey {
  source: ModelKeySource;
  /** Where exactly, for status lines, e.g. "ANTHROPIC_API_KEY". Never the key itself. */
  where: string;
  /** Anthropic: only for the key Alden stored (the SDK finds the others on its own). OpenAI: always. */
  apiKey?: string;
}

export interface ModelKeyDeps {
  env?: NodeJS.ProcessEnv;
  /** Where the Anthropic key is stored. */
  store?: CredentialStore;
  /** Where the OpenAI key is stored. */
  openaiStore?: CredentialStore;
  /** Where `ant auth login` keeps its profiles. */
  profileDir?: string;
}

/** Whose API key: Anthropic's or OpenAI's. Each is stored under its own name ("anthropic", "openai"). */
export type KeyProvider = "anthropic" | "openai";

/**
 * The store for a key from `alden auth model` (Anthropic's unless said): the keychain, or a 0600 file where there is
 * none.
 */
export function modelKeyStore(provider: KeyProvider = "anthropic"): CredentialStore {
  return DefaultCredentialStore.for(provider);
}

/** Where people create an OpenAI API key. */
export const OPENAI_KEYS_URL = "https://platform.openai.com/api-keys";

/**
 * Whether `key` looks like an OpenAI API key (sk-proj-…, sk-svcacct-…, or an older sk-…), or what's wrong with it.
 * Admin keys can't call the models, so they're refused.
 */
export function checkOpenAIKey(key: string): string | undefined {
  if (key.startsWith("sk-admin-")) {
    return `That's an OpenAI Admin key, which can't ask the model. Create an API key at ${OPENAI_KEYS_URL}.`;
  }
  if (key.startsWith("sk-ant-") || !/^sk-[\w-]{20,}$/.test(key)) {
    return "That doesn't look like an OpenAI API key (they start with sk-). Check you copied all of it.";
  }
  return undefined;
}

/** What a pasted key is: Anthropic's or OpenAI's, or why Alden won't use it. */
export type KeyDetection = { ok: true; provider: KeyProvider } | { ok: false; message: string };

/**
 * Tells the two kinds of key apart, so people can paste either: sk-ant-… is Anthropic's (Claude.ai sign-in tokens and
 * Admin keys refused, as `checkModelKey` says), any other sk-… is OpenAI's (Admin keys refused).
 */
export function detectKeyKind(key: string): KeyDetection {
  const trimmed = key.trim();
  if (trimmed.startsWith("sk-ant-")) {
    const problem = checkModelKey(trimmed);
    return problem ? { ok: false, message: problem } : { ok: true, provider: "anthropic" };
  }
  if (trimmed.startsWith("sk-")) {
    const problem = checkOpenAIKey(trimmed);
    return problem ? { ok: false, message: problem } : { ok: true, provider: "openai" };
  }
  return {
    ok: false,
    message:
      "That doesn't look like an API key: Anthropic's start with sk-ant-, OpenAI's with sk-. Check you copied all of it.",
  };
}

/**
 * Whether `key` looks like an Anthropic API key, or what's wrong with it. Admin keys can't call the Messages API, and
 * Claude.ai subscription tokens are never used, so both are refused.
 */
export function checkModelKey(key: string): string | undefined {
  if (key.startsWith("sk-ant-oat")) {
    return "That's a Claude.ai sign-in token, which Alden doesn't use. Create an API key at console.anthropic.com.";
  }
  if (key.startsWith("sk-ant-admin")) {
    return "That's an Admin API key, which can't ask the model. Create an API key at console.anthropic.com.";
  }
  // Anthropic has more than one kind of API key (sk-ant-api03-…, sk-ant-usr…-…), so only the shape is checked.
  if (!/^sk-ant-[a-z]+\d*-[\w-]{20,}$/.test(key)) {
    return "That doesn't look like an Anthropic API key (they start with sk-ant-). Check you copied all of it.";
  }
  return undefined;
}

/** The environment variable that gives the SDK credentials, if any. */
function fromEnv(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE"]) {
    if (env[name]?.trim()) return name;
  }
  if (env.ANTHROPIC_FEDERATION_RULE_ID && (env.ANTHROPIC_IDENTITY_TOKEN || env.ANTHROPIC_IDENTITY_TOKEN_FILE)) {
    return "ANTHROPIC_FEDERATION_RULE_ID";
  }
  return undefined;
}

/**
 * The Anthropic credentials Alden should use, in order: the environment (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
 * ANTHROPIC_PROFILE or workload identity), then the key stored with `alden auth model`, then an `ant auth login`
 * profile. Every surface (the CLI, `alden ui`, `alden mcp`, the desktop app) asks this, so an app opened from the
 * Finder, which never sees your shell's variables, still finds the key. Claude.ai subscription logins are never used.
 */
export async function resolveModelKey(deps: ModelKeyDeps = {}): Promise<ModelKey | undefined> {
  const env = deps.env ?? process.env;
  const variable = fromEnv(env);
  if (variable) return { source: "env", where: variable };

  try {
    const stored = await (deps.store ?? modelKeyStore()).get();
    if (stored) return { source: "alden", where: "the key you stored with `alden auth model`", apiKey: stored };
  } catch {
    // An unreadable keychain or file is the same as no key here; `alden doctor` says more.
  }

  const profileDir = deps.profileDir ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "anthropic");
  if (existsSync(profileDir)) return { source: "ant", where: "your `ant auth login` profile" };
  return undefined;
}

/**
 * The OpenAI key Alden should use: OPENAI_API_KEY, then the key stored with `alden auth model`. Like the Anthropic
 * key, every surface asks this, so the desktop app finds the stored one.
 */
export async function resolveOpenAIKey(deps: ModelKeyDeps = {}): Promise<ModelKey | undefined> {
  const env = deps.env ?? process.env;
  const fromEnv = env.OPENAI_API_KEY?.trim();
  if (fromEnv) return { source: "env", where: "OPENAI_API_KEY", apiKey: fromEnv };
  try {
    const stored = await (deps.openaiStore ?? modelKeyStore("openai")).get();
    if (stored) return { source: "alden", where: "the OpenAI key you stored with `alden auth model`", apiKey: stored };
  } catch {
    // As for Anthropic: an unreadable keychain is no key here.
  }
  return undefined;
}
