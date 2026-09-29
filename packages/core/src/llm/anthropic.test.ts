import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicProvider, toLlmError } from "./anthropic.js";
import { costUsd, resolveModel, worstCaseUsd } from "./models.js";

/** A stand-in SDK client recording the last request and answering with `response`. */
function fakeClient(response: Record<string, unknown>) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    messages: {
      stream: (params: Record<string, unknown>) => {
        calls.push(params);
        return { finalMessage: async () => response };
      },
      countTokens: async (params: Record<string, unknown>) => {
        calls.push(params);
        return { input_tokens: 1234 };
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const Out = z.object({ summary: z.string() });

describe("models", () => {
  it("resolves aliases and passes other names through", () => {
    expect(resolveModel("sonnet")).toBe("claude-sonnet-5");
    expect(resolveModel(" Opus ")).toBe("claude-opus-5");
    expect(resolveModel("haiku")).toBe("claude-haiku-4-5");
    expect(resolveModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(resolveModel("qwen3-coder:30b")).toBe("qwen3-coder:30b");
  });

  it("prices usage at list rates, including cache reads and writes", () => {
    // Sonnet 5: $2 in, $10 out per million.
    expect(
      costUsd("claude-sonnet-5", {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeCloseTo(3);
    expect(
      costUsd("claude-sonnet-5", {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    ).toBeCloseTo(0.2 + 2.5);
    expect(worstCaseUsd("claude-opus-5", 20_000, 16_000)).toBeCloseTo(0.1 + 0.4);
  });

  it("says it doesn't know the price of other models", () => {
    expect(
      costUsd("qwen3-coder:30b", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ).toBeUndefined();
  });
});

describe("AnthropicProvider", () => {
  it("sends a structured-output request to the resolved model and returns the parsed output", async () => {
    const { client, calls } = fakeClient({
      parsed_output: { summary: "Adds review" },
      stop_reason: "end_turn",
      stop_details: null,
      usage,
      model: "claude-sonnet-5",
    });
    const provider = new AnthropicProvider("sonnet", client);
    const result = await provider.generate({ system: "sys", user: "diff", schema: Out, maxOutputTokens: 8000 });

    expect(result).toEqual({
      output: { summary: "Adds review" },
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "end",
      model: "claude-sonnet-5",
    });
    expect(calls[0]).toMatchObject({
      model: "claude-sonnet-5",
      max_tokens: 8000,
      system: "sys",
      messages: [{ role: "user", content: "diff" }],
      output_config: { format: { type: "json_schema" } },
    });
    // Thinking and sampling are left to the model's defaults.
    expect(calls[0]).not.toHaveProperty("thinking");
    expect(calls[0]).not.toHaveProperty("temperature");
  });

  it("reports refusals with their category and no output", async () => {
    const { client } = fakeClient({
      parsed_output: null,
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: "Declined" },
      usage,
      model: "claude-sonnet-5",
    });
    const result = await new AnthropicProvider("sonnet", client).generate({
      system: "s",
      user: "u",
      schema: Out,
      maxOutputTokens: 100,
    });
    expect(result).toMatchObject({
      output: null,
      stopReason: "refusal",
      refusal: { category: "cyber", explanation: "Declined" },
    });
  });

  it("returns no output when the answer was cut off", async () => {
    const { client } = fakeClient({ parsed_output: { summary: "par" }, stop_reason: "max_tokens", usage, model: "m" });
    const result = await new AnthropicProvider("sonnet", client).generate({
      system: "s",
      user: "u",
      schema: Out,
      maxOutputTokens: 100,
    });
    expect(result).toMatchObject({ output: null, stopReason: "max_tokens" });
  });

  it("counts input tokens for the same model", async () => {
    const { client, calls } = fakeClient({});
    expect(await new AnthropicProvider("opus", client).countInputTokens({ system: "s", user: "u" })).toBe(1234);
    expect(calls[0]).toMatchObject({ model: "claude-opus-5", system: "s" });
  });
});

describe("toLlmError", () => {
  const headers = new Headers();
  it.each([
    [new Anthropic.AuthenticationError(401, undefined, "bad key", headers), "auth"],
    [new Anthropic.RateLimitError(429, undefined, "slow down", headers), "rate_limit"],
    [new Anthropic.NotFoundError(404, undefined, "no model", headers), "not_found"],
    [new Anthropic.BadRequestError(400, undefined, "bad", headers), "bad_request"],
    [new Anthropic.InternalServerError(529, undefined, "overloaded", headers), "overloaded"],
    [new Anthropic.APIConnectionError({ message: "offline" }), "network"],
    [new Error("boom"), "other"],
  ])("maps %s to %s", (error, kind) => {
    expect(toLlmError(error).kind).toBe(kind);
  });
});
