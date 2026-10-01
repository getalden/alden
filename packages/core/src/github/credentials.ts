import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Entry } from "@napi-rs/keyring";
import { aldenHome } from "../config.js";

const SERVICE = "alden";
const ACCOUNT = "github";

/** Where Alden keeps its own GitHub token. The OS keychain first, a 0600 file if there is no keychain. */
export interface CredentialStore {
  get(): Promise<string | undefined>;
  set(token: string): Promise<void>;
  delete(): Promise<void>;
}

export function credentialsFilePath(): string {
  return join(aldenHome(), "credentials.json");
}

export class FileCredentialStore implements CredentialStore {
  async get(): Promise<string | undefined> {
    const path = credentialsFilePath();
    if (!existsSync(path)) return undefined;
    const data = JSON.parse(await readFile(path, "utf8")) as { github?: string };
    return data.github;
  }

  async set(token: string): Promise<void> {
    const path = credentialsFilePath();
    await mkdir(aldenHome(), { recursive: true });
    await writeFile(path, JSON.stringify({ github: token }), { mode: 0o600 });
    await chmod(path, 0o600);
  }

  async delete(): Promise<void> {
    await rm(credentialsFilePath(), { force: true });
  }
}

/**
 * The OS keychain, loaded on first use: the native module may not load at all (an unusual Linux, a container), and
 * that should mean "no keychain", handled like any other keychain failure, rather than Alden failing to start.
 */
export class KeychainCredentialStore implements CredentialStore {
  private entry: Promise<Entry> | undefined;

  private open(): Promise<Entry> {
    this.entry ??= import("@napi-rs/keyring").then(({ Entry }) => new Entry(SERVICE, ACCOUNT));
    return this.entry;
  }

  async get(): Promise<string | undefined> {
    return (await this.open()).getPassword() ?? undefined;
  }

  async set(token: string): Promise<void> {
    (await this.open()).setPassword(token);
  }

  async delete(): Promise<void> {
    (await this.open()).deletePassword();
  }
}

/** Uses the keychain, and falls back to the file store for any call the keychain can't serve (e.g. headless Linux). */
export class DefaultCredentialStore implements CredentialStore {
  constructor(
    private readonly keychain: CredentialStore = new KeychainCredentialStore(),
    private readonly file: CredentialStore = new FileCredentialStore(),
  ) {}

  async get(): Promise<string | undefined> {
    try {
      const token = await this.keychain.get();
      if (token) return token;
    } catch {
      // No usable keychain; fall through to the file.
    }
    return this.file.get();
  }

  async set(token: string): Promise<void> {
    try {
      await this.keychain.set(token);
      await this.file.delete();
    } catch {
      await this.file.set(token);
    }
  }

  async delete(): Promise<void> {
    try {
      await this.keychain.delete();
    } catch {
      // Nothing stored there, or no keychain.
    }
    await this.file.delete();
  }
}
