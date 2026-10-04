import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  type CredentialStore,
  credentialsFilePath,
  DefaultCredentialStore,
  FileCredentialStore,
} from "./credentials.js";

const brokenKeychain: CredentialStore = {
  get: async () => {
    throw new Error("no keychain");
  },
  set: async () => {
    throw new Error("no keychain");
  },
  delete: async () => {
    throw new Error("no keychain");
  },
};

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "alden-home-"));
  process.env.ALDEN_HOME = home;
});

afterEach(async () => {
  delete process.env.ALDEN_HOME;
  await rm(home, { recursive: true, force: true });
});

it("falls back to an owner-only file when there is no keychain", async () => {
  const creds = new DefaultCredentialStore(brokenKeychain, new FileCredentialStore());
  await creds.set("gho_test");
  expect(await creds.get()).toBe("gho_test");
  if (process.platform !== "win32") {
    expect((await stat(credentialsFilePath())).mode & 0o777).toBe(0o600);
  }
  await creds.delete();
  expect(await creds.get()).toBeUndefined();
});

it("removes a leftover file once the keychain works", async () => {
  let saved: string | undefined;
  const keychain: CredentialStore = {
    get: async () => saved,
    set: async (t) => {
      saved = t;
    },
    delete: async () => {
      saved = undefined;
    },
  };
  const file = new FileCredentialStore();
  await file.set("old");
  await new DefaultCredentialStore(keychain, file).set("new");
  expect(saved).toBe("new");
  expect(await file.get()).toBeUndefined();
});

it("keeps each secret under its own name in the fallback file", async () => {
  const github = new DefaultCredentialStore(brokenKeychain, new FileCredentialStore("github"));
  const anthropic = new DefaultCredentialStore(brokenKeychain, new FileCredentialStore("anthropic"));
  await github.set("gho_test");
  await anthropic.set("sk-ant-api03-test");
  expect(await github.get()).toBe("gho_test");
  expect(await anthropic.get()).toBe("sk-ant-api03-test");
  await anthropic.delete();
  expect(await github.get()).toBe("gho_test");
  expect(await anthropic.get()).toBeUndefined();
  await github.delete();
  expect(existsSync(credentialsFilePath())).toBe(false);
});
