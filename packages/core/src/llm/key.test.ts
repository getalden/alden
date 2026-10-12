import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CredentialStore } from "../github/credentials.js";
import { checkModelKey, checkOpenAIKey, detectKeyKind, resolveModelKey, resolveOpenAIKey } from "./key.js";

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
    expect(checkModelKey(`sk-ant-usr01-${"a".repeat(40)}`)).toBeUndefined();
    expect(checkModelKey(`sk-proj-${"a".repeat(40)}`)).toMatch(/doesn't look like/);
    expect(checkModelKey(`${KEY} trailing`)).toMatch(/doesn't look like/);
  });
});

describe("detectKeyKind", () => {
  const OPENAI = `sk-proj-${"b".repeat(48)}`;

  it("tells Anthropic keys from OpenAI keys by their shape", () => {
    expect(detectKeyKind(KEY)).toEqual({ ok: true, provider: "anthropic" });
    expect(detectKeyKind(` ${OPENAI}\n`)).toEqual({ ok: true, provider: "openai" });
    expect(detectKeyKind(`sk-svcacct-${"c".repeat(40)}`)).toEqual({ ok: true, provider: "openai" });
    expect(detectKeyKind(`sk-${"d".repeat(48)}`)).toEqual({ ok: true, provider: "openai" });
  });

  it("refuses Claude.ai tokens, admin keys of either kind, and things that aren't keys", () => {
    const message = (key: string) => {
      const found = detectKeyKind(key);
      return found.ok ? "ok" : found.message;
    };
    expect(message(`sk-ant-oat01-${"a".repeat(40)}`)).toMatch(/Claude\.ai/);
    expect(message(`sk-ant-admin01-${"a".repeat(40)}`)).toMatch(/Admin API key/);
    expect(message(`sk-admin-${"a".repeat(40)}`)).toMatch(/OpenAI Admin key/);
    expect(message("sk-proj-short")).toMatch(/doesn't look like an OpenAI/);
    expect(message("ghp_abcdefghijklmnopqrstuvwxyz")).toMatch(/Anthropic's start with sk-ant-, OpenAI's with sk-/);
    expect(message(`${OPENAI} trailing`)).toMatch(/doesn't look like/);
  });

  it("never takes an Anthropic-looking key as OpenAI's", () => {
    expect(checkOpenAIKey(KEY)).toMatch(/doesn't look like an OpenAI/);
  });
});

describe("resolveOpenAIKey", () => {
  const OPENAI = `sk-proj-${"b".repeat(48)}`;

  it("prefers OPENAI_API_KEY, then the stored key, and never mixes in the Anthropic store", async () => {
    expect(await resolveOpenAIKey({ env: { OPENAI_API_KEY: "sk-env" }, openaiStore: store(OPENAI) })).toEqual({
      source: "env",
      where: "OPENAI_API_KEY",
      apiKey: "sk-env",
    });
    const stored = await resolveOpenAIKey({ env: { OPENAI_API_KEY: " " }, openaiStore: store(OPENAI) });
    expect(stored).toMatchObject({ source: "alden", apiKey: OPENAI });
    expect(stored?.where).not.toContain("sk-");
    expect(await resolveOpenAIKey({ env: {}, store: store(KEY), openaiStore: store() })).toBeUndefined();
  });
});
