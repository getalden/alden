import type { KeyTestResult, ModelSetupState } from "@alden/schema";
import { describe, expect, it } from "vitest";
import { CLOUD_LINE, runSetup, type SetupIo, type SetupSteps, setupPlan } from "./setup.js";

const KEY = `sk-ant-api03-${"a".repeat(40)}`;

function state(overrides: Partial<ModelSetupState> = {}): ModelSetupState {
  return {
    current: {
      provider: "anthropic",
      model: "claude-sonnet-5",
      available: false,
      reason: "No Anthropic API key found",
    },
    key: null,
    ollama: { reachable: false, url: "http://localhost:11434", version: null, models: [], reason: "not running" },
    memoryGb: 24,
    recommendation: {
      model: "qwen2.5-coder:14b",
      download: "9 GB",
      why: "fits 16 to 32 GB of memory",
      installed: false,
    },
    ...overrides,
  };
}

/** A scripted terminal: answers in order, the key for the hidden prompt, everything printed kept. */
function script(answers: string[], secrets: string[] = []) {
  const out: string[] = [];
  const io: SetupIo = {
    print: (text) => out.push(text),
    ask: async (question) => {
      out.push(question);
      return answers.shift() ?? "";
    },
    secret: async (question) => {
      out.push(question);
      return secrets.shift() ?? "";
    },
    progress: (text, done) => {
      if (!done) out.push(`[${text}]`);
    },
  };
  return { io, text: () => out.join("\n") };
}

function steps(overrides: Partial<SetupSteps> & { now?: ModelSetupState } = {}) {
  const calls: string[] = [];
  const all: SetupSteps = {
    state: async () => overrides.now ?? state(),
    setUpKey: async (key, untested) => {
      calls.push(`key ${key === KEY ? "KEY" : key} ${untested ? "untested" : "tested"}`);
      return { ok: true, key: { source: "alden", where: "the key you stored" } };
    },
    pull: async (model, _url, onProgress) => {
      calls.push(`pull ${model}`);
      onProgress({ status: "pulling 6a07", completed: 4_500_000_000, total: 9_000_000_000 });
      onProgress({ status: "success", completed: null, total: null });
    },
    useLocal: async (model, url) => {
      calls.push(`use ${model} ${url}`);
      return `${url}/v1`;
    },
    ...overrides,
  };
  return { steps: all, calls };
}

describe("alden setup", () => {
  it("tests and stores a pasted key, and ends with the Alden Cloud line", async () => {
    const { io, text } = script(["1"], [KEY]);
    const { steps: s, calls } = steps();
    expect(await runSetup(io, s)).toBe(true);
    expect(calls).toEqual(["key KEY tested"]);
    expect(text()).toContain("https://console.anthropic.com/settings/keys");
    expect(text()).toContain("one tiny request (a fraction of a cent)");
    expect(text()).not.toContain(KEY);
    expect(text().trim().endsWith(CLOUD_LINE)).toBe(true);
  });

  it("offers another try for a refused key, and to store unchecked when Anthropic can't be reached", async () => {
    const results: KeyTestResult[] = [
      { ok: false, reason: "invalid", message: "Anthropic didn't accept that key." },
      { ok: false, reason: "network", message: "Couldn't reach api.anthropic.com." },
      { ok: true, key: { source: "env", where: "ANTHROPIC_API_KEY" } },
    ];
    const calls: boolean[] = [];
    const { io, text } = script(["1", "", "y"], ["sk-ant-api03-wrong", KEY]);
    const ok = await runSetup(io, {
      ...steps().steps,
      setUpKey: async (_key, untested) => {
        calls.push(untested);
        return results.shift() as KeyTestResult;
      },
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([false, false, true]);
    expect(text()).toContain("Anthropic didn't accept that key.");
    expect(text()).toContain("ANTHROPIC_API_KEY is set here and comes first");
  });

  it("pulls the recommended local model with progress, then uses it", async () => {
    const now = state({
      ollama: {
        reachable: true,
        url: "http://localhost:11434",
        version: "0.12.3",
        models: [{ name: "llama3.2:3b", sizeBytes: 2_000_000_000, parameterSize: "3.2B" }],
        reason: null,
      },
    });
    const { io, text } = script(["2", ""]);
    const { steps: s, calls } = steps({ now });
    expect(await runSetup(io, s)).toBe(true);
    expect(calls).toEqual(["pull qwen2.5-coder:14b", "use qwen2.5-coder:14b http://localhost:11434"]);
    expect(text()).toContain("1  Pull qwen2.5-coder:14b");
    expect(text()).toContain("2  Use  llama3.2:3b");
    expect(text()).toContain("[pulling 6a07 50% of 9.0 GB]");
    expect(text()).toContain("Local models flag less than Claude");
  });

  it("uses a pulled model without downloading, and says how to get Ollama when it isn't running", async () => {
    const pulled = state({
      ollama: {
        reachable: true,
        url: "http://localhost:11434",
        version: null,
        models: [{ name: "qwen2.5-coder:14b", sizeBytes: 9_000_000_000, parameterSize: "14.8B" }],
        reason: null,
      },
      recommendation: { model: "qwen2.5-coder:14b", download: "9 GB", why: "fits", installed: true },
    });
    const first = steps({ now: pulled });
    expect(await runSetup(script(["2", "1"]).io, first.steps)).toBe(true);
    expect(first.calls).toEqual(["use qwen2.5-coder:14b http://localhost:11434"]);

    const missing = script(["2"]);
    const second = steps();
    expect(await runSetup(missing.io, second.steps)).toBe(false);
    expect(second.calls).toEqual([]);
    expect(missing.text()).toContain("https://ollama.com/download");
  });

  it("changes nothing for checks only", async () => {
    const { io, text } = script(["3"]);
    const { steps: s, calls } = steps();
    expect(await runSetup(io, s)).toBe(true);
    expect(calls).toEqual([]);
    expect(text()).toContain("Checks only");
  });

  it("without a terminal, prints what it would do and the commands", () => {
    const plan = setupPlan(state());
    expect(plan).toContain("alden auth model");
    expect(plan).toContain("ollama pull qwen2.5-coder:14b");
    expect(plan).toContain("alden config set model.provider openai-compatible");
    expect(plan).toContain("Now: no model set up");
    expect(plan).toContain(CLOUD_LINE);
  });
});
