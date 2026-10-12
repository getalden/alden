import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LlmOutputWithDraftsSchema } from "../review/llm/prompt.js";
import { costUsd, priceFor } from "./models.js";
import { OpenAIProvider, strictSchema, withoutNulls } from "./openai.js";
import { LlmError } from "./provider.js";

const Out = z.object({ summary: z.string(), topic: z.enum(["a", "b"]).optional() });
const request = { system: "sys", user: "diff", schema: Out, maxOutputTokens: 4000 };

function server(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const doFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { doFetch, calls };
}

const completion = (
  content: string,
  usage: Record<string, unknown> = { prompt_tokens: 1000, completion_tokens: 200 },
) => ({
  model: "gpt-6.1-sol-2026-09-01",
  choices: [{ message: { content }, finish_reason: "stop" }],
  usage,
});

/** Every object in a JSON Schema, for checking what strict mode demands of each. */
function objects(schema: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(schema)) for (const s of schema) objects(s, found);
  else if (schema && typeof schema === "object") {
    const node = schema as Record<string, unknown>;
    if (node.type === "object") found.push(node);
    for (const value of Object.values(node)) objects(value, found);
  }
  return found;
}

describe("strictSchema", () => {
  it("makes the briefing's shape strict: every property required, optional ones nullable, nothing extra", () => {
    const strict = strictSchema(z.toJSONSchema(LlmOutputWithDraftsSchema)) as Record<string, unknown>;
    expect(strict.$schema).toBeUndefined();
    const all = objects(strict);
    expect(all.length).toBeGreaterThan(3);
    for (const node of all) {
      expect(node.additionalProperties).toBe(false);
      expect(node.required).toEqual(Object.keys(node.properties as object));
    }
    expect(JSON.stringify(strict)).toContain('{"type":"null"}');
  });

  it("drops the nulls a strict answer carries for the fields the model left out", () => {
    expect(withoutNulls({ a: 1, b: null, c: [{ d: null, e: "x" }] })).toEqual({ a: 1, c: [{ e: "x" }] });
  });
});

describe("OpenAIProvider", () => {
  it("asks OpenAI for strict structured output with max_completion_tokens and the key, and validates the answer", async () => {
    const { doFetch, calls } = server(200, completion('{"summary":"Adds retries","topic":null}'));
    const provider = new OpenAIProvider("gpt-6.1-sol", "sk-proj-test", undefined, doFetch);
    const result = await provider.generate({ ...request, effort: "xhigh" });

    expect(provider.provider).toBe("openai");
    expect(result.output).toEqual({ summary: "Adds retries" });
    expect(result.stopReason).toBe("end");
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer sk-proj-test");
    const sent = JSON.parse(String(calls[0]?.init.body));
    expect(sent).toMatchObject({
      model: "gpt-6.1-sol",
      max_completion_tokens: 4000,
      reasoning_effort: "xhigh",
      response_format: { type: "json_schema", json_schema: { name: "review", strict: true } },
    });
    expect(sent.max_tokens).toBeUndefined();
    expect(sent.response_format.json_schema.schema.required).toEqual(["summary", "topic"]);
  });

  it("sends no effort to a model that doesn't list Alden's levels", async () => {
    const { doFetch, calls } = server(200, completion('{"summary":"x"}'));
    await new OpenAIProvider("gpt-4.1", "k", undefined, doFetch).generate({ ...request, effort: "high" });
    expect(JSON.parse(String(calls[0]?.init.body)).reasoning_effort).toBeUndefined();
  });

  it("counts cached input apart, so the spend is right for the dated snapshot that answered", async () => {
    const usage = {
      prompt_tokens: 10_000,
      completion_tokens: 1_000,
      prompt_tokens_details: { cached_tokens: 6_000, cache_write_tokens: 2_000 },
    };
    const { doFetch } = server(200, completion('{"summary":"x"}', usage));
    const result = await new OpenAIProvider("gpt-6.1-sol", "k", undefined, doFetch).generate(request);
    expect(result.usage).toEqual({
      inputTokens: 2_000,
      outputTokens: 1_000,
      cacheReadTokens: 6_000,
      cacheWriteTokens: 2_000,
    });
    expect(priceFor(result.model)).toEqual(priceFor("gpt-6.1-sol"));
    // 2,000 × $2 + 6,000 × $0.10 + 2,000 × $2.50 + 1,000 × $10, per million.
    expect(costUsd(result.model, result.usage)).toBeCloseTo(0.0196, 6);
  });

  it("turns a rejected key into an auth error", async () => {
    const { doFetch } = server(401, { error: { message: "Incorrect API key provided" } });
    const failing = new OpenAIProvider("gpt-6.1-sol", "bad", undefined, doFetch).generate(request);
    await expect(failing).rejects.toBeInstanceOf(LlmError);
    await expect(failing).rejects.toMatchObject({ kind: "auth" });
  });

  it("says api.openai.com when it can't be reached", async () => {
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(new OpenAIProvider("gpt-6.1-sol", "k", undefined, offline).generate(request)).rejects.toMatchObject({
      kind: "network",
      message: expect.stringMatching(/api\.openai\.com/),
    });
  });
});

describe("OpenAI prices", () => {
  it("knows the models Alden offers, and leaves Claude's alone", () => {
    expect(priceFor("gpt-6-astra")).toMatchObject({ input: 10, output: 50 });
    expect(priceFor("gpt-6-luna")).toMatchObject({ input: 0.1, output: 0.5 });
    expect(priceFor("gpt-unknown")).toBeUndefined();
    // Claude keeps Anthropic's cache multipliers: reads at 0.1x, writes at 1.25x.
    expect(
      costUsd("claude-sonnet-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 }),
    ).toBeCloseTo(0.2 + 2.5, 6);
  });
});
