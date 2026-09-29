import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { createPlatformClient, platformModelId } from "./platforms.js";

const Out = z.object({ summary: z.string() });
const request = { system: "sys", user: "diff", schema: Out, maxOutputTokens: 4000 };

function server(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const doFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { doFetch, calls };
}

const completion = (content: string, finish = "stop", extra: Record<string, unknown> = {}) => ({
  model: "qwen3-coder:30b",
  choices: [{ message: { content, ...extra }, finish_reason: finish }],
  usage: { prompt_tokens: 900, completion_tokens: 120 },
});

describe("OpenAICompatibleProvider", () => {
  it("asks for JSON Schema output and returns it validated", async () => {
    const { doFetch, calls } = server(200, completion('{"summary":"Adds review"}'));
    const provider = new OpenAICompatibleProvider("qwen3-coder:30b", "http://localhost:11434/v1/", undefined, doFetch);
    const result = await provider.generate(request);

    expect(result).toEqual({
      output: { summary: "Adds review" },
      usage: { inputTokens: 900, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "end",
      model: "qwen3-coder:30b",
    });
    expect(calls[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    const sent = JSON.parse(String(calls[0]?.init.body));
    expect(sent).toMatchObject({
      model: "qwen3-coder:30b",
      max_tokens: 4000,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "diff" },
      ],
      response_format: { type: "json_schema", json_schema: { name: "review", strict: true } },
    });
    expect(sent.response_format.json_schema.schema.required).toEqual(["summary"]);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBeNull();
  });

  it("sends an API key when one is set", async () => {
    const { doFetch, calls } = server(200, completion('{"summary":"x"}'));
    await new OpenAICompatibleProvider("m", "https://openrouter.ai/api/v1", "sk-or-test", doFetch).generate(request);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer sk-or-test");
  });

  it("returns no output for answers that don't fit the schema, aren't JSON, or were cut off", async () => {
    for (const [body, stop] of [
      [completion('{"wrong":1}'), "end"],
      [completion("not json"), "end"],
      [completion('{"summary":"par', "length"), "max_tokens"],
    ] as const) {
      const { doFetch } = server(200, body);
      const result = await new OpenAICompatibleProvider("m", undefined, undefined, doFetch).generate(request);
      expect(result).toMatchObject({ output: null, stopReason: stop });
    }
  });

  it("reports refusals", async () => {
    const { doFetch } = server(200, completion("", "stop", { refusal: "I can't help with that." }));
    const result = await new OpenAICompatibleProvider("m", undefined, undefined, doFetch).generate(request);
    expect(result).toMatchObject({
      output: null,
      stopReason: "refusal",
      refusal: { explanation: "I can't help with that." },
    });
  });

  it("maps HTTP failures and unreachable servers to error kinds", async () => {
    for (const [status, kind] of [
      [401, "auth"],
      [404, "not_found"],
      [429, "rate_limit"],
      [503, "overloaded"],
      [400, "bad_request"],
    ] as const) {
      const { doFetch } = server(status, "nope");
      await expect(
        new OpenAICompatibleProvider("m", undefined, undefined, doFetch).generate(request),
      ).rejects.toMatchObject({ kind });
    }
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(
      new OpenAICompatibleProvider("m", undefined, undefined, offline).generate(request),
    ).rejects.toMatchObject({
      kind: "network",
      message: expect.stringMatching(/Is the server running\?/),
    });
  });

  it("can't count tokens, so budgets estimate", async () => {
    expect(await new OpenAICompatibleProvider("m").countInputTokens()).toBeUndefined();
  });
});

describe("platforms", () => {
  it("prefixes Bedrock model IDs only", () => {
    expect(platformModelId("bedrock", "claude-sonnet-5")).toBe("anthropic.claude-sonnet-5");
    expect(platformModelId("bedrock", "anthropic.claude-opus-5")).toBe("anthropic.claude-opus-5");
    expect(platformModelId("vertex", "claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("explains a platform that can't start without credentials", async () => {
    vi.stubEnv("ANTHROPIC_FOUNDRY_API_KEY", "");
    await expect(
      createPlatformClient("foundry", { provider: "foundry", name: "sonnet", resource: "r" }),
    ).rejects.toMatchObject({
      kind: "setup",
      message: expect.stringMatching(/^Couldn't set up foundry: .*ANTHROPIC_FOUNDRY_API_KEY/),
    });
  });

  it.each(["bedrock", "vertex", "foundry"] as const)(
    "creates the %s client with the Messages API",
    async (platform) => {
      vi.stubEnv("ANTHROPIC_FOUNDRY_API_KEY", "test-key");
      const client = await createPlatformClient(platform, {
        provider: platform,
        name: "sonnet",
        region: "us-east-1",
        projectId: "alden-test",
        resource: "alden-test",
      });
      expect(typeof client.messages.parse).toBe("function");
      expect(typeof client.messages.countTokens).toBe("function");
    },
  );
});
