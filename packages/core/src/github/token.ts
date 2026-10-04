import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type CredentialStore, DefaultCredentialStore, KeychainCredentialStore } from "./credentials.js";

const run = promisify(execFile);

export type TokenSource = "env" | "alden" | "gh";

export interface ResolvedToken {
  token: string;
  source: TokenSource;
}

/** Reads the token the GitHub CLI is signed in with, or undefined if `gh` is missing or signed out. */
export async function ghCliToken(): Promise<string | undefined> {
  try {
    const { stdout } = await run("gh", ["auth", "token", "--hostname", "github.com"], { timeout: 5_000 });
    const token = stdout.trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

export interface ResolveDeps {
  env?: NodeJS.ProcessEnv;
  store?: CredentialStore;
  ghToken?: () => Promise<string | undefined>;
}

/**
 * The token Alden should use, in order: `ALDEN_GITHUB_TOKEN`, the token Alden stored at sign-in, then the GitHub CLI's.
 * `GITHUB_TOKEN` is deliberately ignored: in CI it is a narrow Actions token, not the reviewer's.
 */
export async function resolveToken(deps: ResolveDeps = {}): Promise<ResolvedToken | undefined> {
  const env = deps.env ?? process.env;
  const fromEnv = env.ALDEN_GITHUB_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "env" };

  const stored = await (deps.store ?? new DefaultCredentialStore()).get();
  if (stored) return { token: stored, source: "alden" };

  const fromGh = await (deps.ghToken ?? ghCliToken)();
  if (fromGh) return { token: fromGh, source: "gh" };

  return undefined;
}

/**
 * Why there's no token, for a sign-in screen that would otherwise just ask again: the keychain refused to answer (as
 * it does for an unsigned copy of Alden.app, such as a development build), or nothing is signed in anywhere.
 */
export type SignInProblem = { kind: "keychain"; detail: string } | { kind: "none" };

export async function whyNoToken(keychain: CredentialStore = new KeychainCredentialStore()): Promise<SignInProblem> {
  try {
    await keychain.get();
    return { kind: "none" };
  } catch (error) {
    return { kind: "keychain", detail: ((error as Error).message || String(error)).slice(0, 200) };
  }
}
