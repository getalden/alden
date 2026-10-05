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
  /** Only for the key Alden stored: the SDK finds the others on its own. */
  apiKey?: string;
}

export interface ModelKeyDeps {
  env?: NodeJS.ProcessEnv;
  store?: CredentialStore;
  /** Where `ant auth login` keeps its profiles. */
  profileDir?: string;
}

/** The store for the key from `alden auth model`: the keychain, or a 0600 file where there is none. */
export function modelKeyStore(): CredentialStore {
  return DefaultCredentialStore.for("anthropic");
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
