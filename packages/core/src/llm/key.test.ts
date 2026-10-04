import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CredentialStore } from "../github/credentials.js";
import { checkModelKey, resolveModelKey } from "./key.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alden-key-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const store = (key?: string): CredentialStore => ({
  get: async () => key,
  set: async () => {},
  delete: async () => {},
});
const KEY = `sk-ant-api03-${"a".repeat(40)}`;

describe("resolveModelKey", () => {
  const missing = () => join(dir, "no-profiles");

  it("prefers the environment: keys, tokens, profiles and workload identity", async () => {
    const env = async (vars: NodeJS.ProcessEnv) =>
      (await resolveModelKey({ env: vars, store: store(KEY), profileDir: missing() }))?.where;
    expect(await env({ ANTHROPIC_API_KEY: "k" })).toBe("ANTHROPIC_API_KEY");
    expect(await env({ ANTHROPIC_AUTH_TOKEN: "t" })).toBe("ANTHROPIC_AUTH_TOKEN");
    expect(await env({ ANTHROPIC_FEDERATION_RULE_ID: "r", ANTHROPIC_IDENTITY_TOKEN_FILE: "/f" })).toBe(
      "ANTHROPIC_FEDERATION_RULE_ID",
    );
  });

  it("then the stored key, handing it over, then an ant profile", async () => {
    const stored = await resolveModelKey({ env: { ANTHROPIC_API_KEY: " " }, store: store(KEY), profileDir: dir });
    expect(stored).toMatchObject({ source: "alden", apiKey: KEY });
    expect(await resolveModelKey({ env: {}, store: store(), profileDir: dir })).toMatchObject({ source: "ant" });
  });

  it("finds nothing in an empty environment, and treats an unreadable keychain as no key", async () => {
    expect(await resolveModelKey({ env: {}, store: store(), profileDir: missing() })).toBeUndefined();
    const refusing: CredentialStore = {
      ...store(),
      get: async () => {
        throw new Error("denied");
      },
    };
    expect(await resolveModelKey({ env: {}, store: refusing, profileDir: missing() })).toBeUndefined();
  });

  it("never puts the key where a status line would show it", async () => {
    const found = await resolveModelKey({ env: {}, store: store(KEY), profileDir: missing() });
    expect(found?.where).not.toContain("sk-ant");
  });
});

describe("checkModelKey", () => {
  it("takes API keys, and refuses admin keys, Claude.ai tokens and typos", () => {
    expect(checkModelKey(KEY)).toBeUndefined();
    expect(checkModelKey(`sk-ant-admin01-${"a".repeat(40)}`)).toMatch(/Admin API key/);
    expect(checkModelKey(`sk-ant-oat01-${"a".repeat(40)}`)).toMatch(/Claude\.ai/);
    expect(checkModelKey("sk-ant-api03-short")).toMatch(/doesn't look like/);
    expect(checkModelKey(`${KEY} trailing`)).toMatch(/doesn't look like/);
  });
});
