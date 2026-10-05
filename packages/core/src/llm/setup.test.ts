import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, setConfigValue, userConfigPath } from "../config.js";
import type { CredentialStore } from "../github/credentials.js";
import { KEY_TEST_MODEL, type KeyTestClient, modelSetupState, setUpModelKey, testModelKey } from "./setup.js";

const KEY = `sk-ant-api03-${"a".repeat(40)}`;
const headers = new Headers();

/** A fake SDK: records the request and answers with `outcome` (an error is thrown). */
function client(outcome: unknown = { id: "msg_1" }) {
  const calls: { apiKey: string; body: unknown }[] = [];
  const make: KeyTestClient = (apiKey) => ({
    messages: {
      create: async (body) => {
        calls.push({ apiKey, body });
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    },
  });
  return { make, calls };
}

function memoryStore(initial?: string): CredentialStore & { value: string | undefined } {
  const store = {
    value: initial,
    get: async () => store.value,
    set: async (v: string) => {
      store.value = v;
    },
    delete: async () => {
      store.value = undefined;
    },
  };
  return store;
}

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "alden-setup-"));
  process.env.ALDEN_HOME = home;
});
afterEach(async () => {
  delete process.env.ALDEN_HOME;
  await rm(home, { recursive: true, force: true });
});

describe("testModelKey", () => {
  it("asks the smallest model for one token", async () => {
    const { make, calls } = client();
    expect(await testModelKey(` ${KEY}\n`, make)).toEqual({ ok: true, key: null });
    expect(calls).toEqual([
      { apiKey: KEY, body: { model: KEY_TEST_MODEL, max_tokens: 1, messages: [{ role: "user", content: "Hi" }] } },
    ]);
  });

  it("checks the shape first, and makes no request for a key that can't be one", async () => {
    const { make, calls } = client();
    expect(await testModelKey("sk-proj-nope", make)).toMatchObject({ ok: false, reason: "shape" });
    expect(calls).toEqual([]);
  });

  it("says why a key doesn't work", async () => {
    const reason = async (error: Error) => {
      const result = await testModelKey(KEY, client(error).make);
      return result.ok ? "ok" : result.reason;
    };
    expect(await reason(new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key", headers))).toBe(
      "invalid",
    );
    expect(await reason(new Anthropic.PermissionDeniedError(403, undefined, "forbidden", headers))).toBe("permission");
    expect(
      await reason(
        new Anthropic.BadRequestError(
          400,
          undefined,
          "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
          headers,
        ),
      ),
    ).toBe("billing");
    expect(await reason(new Anthropic.APIConnectionError({ message: "Connection error." }))).toBe("network");
    expect(await reason(new Anthropic.InternalServerError(529, undefined, "overloaded", headers))).toBe("unavailable");
    expect(await reason(new Anthropic.BadRequestError(400, undefined, "something else", headers))).toBe("other");
    // Signed in but busy: the key itself works.
    expect(await reason(new Anthropic.RateLimitError(429, undefined, "slow down", headers))).toBe("ok");
  });

  it("never puts the key in its answer", async () => {
    const result = await testModelKey(
      KEY,
      client(new Anthropic.AuthenticationError(401, undefined, KEY, headers)).make,
    );
    expect(JSON.stringify(result)).not.toContain("sk-ant-api03");
  });
});

describe("setUpModelKey", () => {
  const noProfiles = () => join(home, "no-profiles");

  it("stores a key that works, and says where Alden now gets it", async () => {
    const store = memoryStore();
    const result = await setUpModelKey(KEY, { client: client().make, store, env: {}, profileDir: noProfiles() });
    expect(store.value).toBe(KEY);
    expect(result).toEqual({ ok: true, key: { source: "alden", where: "the key you stored with `alden auth model`" } });
  });

  it("stores nothing when Anthropic refuses the key", async () => {
    const store = memoryStore();
    const failing = client(new Anthropic.AuthenticationError(401, undefined, "bad", headers));
    const result = await setUpModelKey(KEY, { client: failing.make, store, env: {}, profileDir: noProfiles() });
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(store.value).toBeUndefined();
  });

  it("stores without the request only when asked to, and says an environment key still comes first", async () => {
    const store = memoryStore();
    const { make, calls } = client();
    const result = await setUpModelKey(KEY, {
      client: make,
      untested: true,
      store,
      env: { ANTHROPIC_API_KEY: "x" },
      profileDir: noProfiles(),
    });
    expect(calls).toEqual([]);
    expect(store.value).toBe(KEY);
    expect(result).toEqual({ ok: true, key: { source: "env", where: "ANTHROPIC_API_KEY" } });
  });

  it("makes Claude the model again after a local one", async () => {
    await setConfigValue("model.provider", "openai-compatible");
    await setConfigValue("model.name", "qwen2.5-coder:7b");
    await setUpModelKey(KEY, { client: client().make, store: memoryStore(), env: {}, profileDir: noProfiles() });
    const config = await loadConfig(home);
    expect(config.model).toMatchObject({ provider: "anthropic", name: "sonnet" });
  });

  it("keeps a Claude model you chose", async () => {
    await writeFile(userConfigPath(), 'model = { provider = "anthropic", name = "opus" }\n');
    await setUpModelKey(KEY, { client: client().make, store: memoryStore(), env: {}, profileDir: noProfiles() });
    expect((await loadConfig(home)).model.name).toBe("opus");
  });
});

describe("modelSetupState", () => {
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  it("describes a machine with nothing set up", async () => {
    const state = await modelSetupState({
      cwd: home,
      env: {},
      store: memoryStore(),
      profileDir: join(home, "none"),
      fetch: offline,
      totalMemory: 16 * 1024 ** 3,
    });
    expect(state).toMatchObject({
      current: { provider: "anthropic", model: "claude-sonnet-5", available: false },
      key: null,
      ollama: { reachable: false, url: "http://localhost:11434", models: [] },
      memoryGb: 16,
      recommendation: { model: "qwen2.5-coder:14b", installed: false },
    });
    expect(state.current.reason).toMatch(/No Anthropic API key/);
  });

  it("finds a stored key, and a key while a local model is in use", async () => {
    const state = await modelSetupState({
      cwd: home,
      env: {},
      store: memoryStore(KEY),
      profileDir: join(home, "none"),
      fetch: offline,
      totalMemory: 8 * 1024 ** 3,
    });
    expect(state.current.available).toBe(true);
    expect(state.key).toEqual({ source: "alden", where: "the key you stored with `alden auth model`" });
    expect(JSON.stringify(state)).not.toContain("sk-ant");

    await setConfigValue("model.provider", "openai-compatible");
    await setConfigValue("model.name", "qwen2.5-coder:7b");
    const local = await modelSetupState({
      cwd: home,
      env: {},
      store: memoryStore(KEY),
      profileDir: join(home, "none"),
      fetch: offline,
      totalMemory: 8 * 1024 ** 3,
    });
    expect(local.current).toMatchObject({ provider: "openai-compatible", model: "qwen2.5-coder:7b", available: true });
    expect(local.key?.source).toBe("alden");
  });
});
