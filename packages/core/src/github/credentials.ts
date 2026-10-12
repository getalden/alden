import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Entry } from "@napi-rs/keyring";
import { aldenHome } from "../config.js";

const SERVICE = "alden";

/** What Alden keeps: its own GitHub token, and the Anthropic API key from `alden auth model`. */
export type CredentialName = "github" | "anthropic" | "openai";

/** Where Alden keeps a secret. The OS keychain first, a 0600 file if there is no keychain. */
export interface CredentialStore {
  get(): Promise<string | undefined>;
  set(token: string): Promise<void>;
  delete(): Promise<void>;
}

export function credentialsFilePath(): string {
  return join(aldenHome(), "credentials.json");
}

/** One file for every secret, by name, so storing the model key keeps the GitHub token (and the other way round). */
export class FileCredentialStore implements CredentialStore {
  constructor(private readonly name: CredentialName = "github") {}

  private async read(): Promise<Partial<Record<CredentialName, string>>> {
    const path = credentialsFilePath();
    if (!existsSync(path)) return {};
    return JSON.parse(await readFile(path, "utf8")) as Partial<Record<CredentialName, string>>;
  }

  private async write(data: Partial<Record<CredentialName, string>>): Promise<void> {
    const path = credentialsFilePath();
    if (Object.keys(data).length === 0) {
      await rm(path, { force: true });
      return;
    }
    await mkdir(aldenHome(), { recursive: true });
    await writeFile(path, JSON.stringify(data), { mode: 0o600 });
    await chmod(path, 0o600);
  }

  async get(): Promise<string | undefined> {
    return (await this.read())[this.name];
  }

  async set(token: string): Promise<void> {
    await this.write({ ...(await this.read().catch(() => ({}))), [this.name]: token });
  }

  async delete(): Promise<void> {
    const data: Partial<Record<CredentialName, string>> = await this.read().catch(() => ({}));
    delete data[this.name];
    await this.write(data);
  }
}

/**
 * The OS keychain, loaded on first use: the native module may not load at all (an unusual Linux, a container), and
 * that should mean "no keychain", handled like any other keychain failure, rather than Alden failing to start.
 */
export class KeychainCredentialStore implements CredentialStore {
  private entry: Promise<Entry> | undefined;

  constructor(private readonly name: CredentialName = "github") {}

  private open(): Promise<Entry> {
    this.entry ??= import("@napi-rs/keyring").then(({ Entry }) => new Entry(SERVICE, this.name));
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

  /** The store for one secret; the default one is the GitHub token's. */
  static for(name: CredentialName): DefaultCredentialStore {
    return new DefaultCredentialStore(new KeychainCredentialStore(name), new FileCredentialStore(name));
  }

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
