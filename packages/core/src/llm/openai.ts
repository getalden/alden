import { z } from "zod";
import type { TokenUsage } from "./models.js";
import { type ChatCompletion, OpenAICompatibleProvider } from "./openai-compatible.js";
import type { Effort, GenerateRequest } from "./provider.js";

/** OpenAI's own API. */
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** What Alden uses when you paste an OpenAI key and haven't picked a model: near the top model, at a fifth of its price. */
export const DEFAULT_OPENAI_MODEL = "gpt-6.1-sol";

/**
 * The reasoning efforts each OpenAI model takes, from its page under https://developers.openai.com/api/docs/models
 * (checked 12 October 2026). The GPT-6 models take all of Alden's levels; other models get no effort parameter, so
 * their own default applies rather than a value they'd refuse.
 */
const OPENAI_EFFORTS: Record<string, readonly Effort[]> = {
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6-luna": ["low", "medium", "high", "xhigh", "max"],
};

/** Whether an OpenAI model takes Alden's effort levels. */
export function openAiSupportsEffort(model: string): boolean {
  return OPENAI_EFFORTS[model] !== undefined;
}

/** Whether a model name is one of OpenAI's (gpt-…, o1, o3, o4-mini…), as opposed to a Claude or local model. */
export function isOpenAiModel(model: string): boolean {
  return /^(gpt-|o\d|chatgpt-)/.test(model);
}

type JsonSchema = Record<string, unknown>;

/**
 * Structured Outputs in strict mode wants every property required and no extra properties. Alden's output schemas
 * have optional fields, so those become required-but-nullable here, and `withoutNulls` drops the nulls again before
 * zod checks the answer. `$schema` goes: OpenAI doesn't take it.
 */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema as JsonSchema)) {
    if (key === "$schema") continue;
    // zod bounds every integer to the safe range; that says nothing, so it's left out.
    if (key === "minimum" && value === Number.MIN_SAFE_INTEGER) continue;
    if (key === "maximum" && value === Number.MAX_SAFE_INTEGER) continue;
    if (key === "properties" && value && typeof value === "object") {
      out.properties = Object.fromEntries(Object.entries(value as JsonSchema).map(([k, v]) => [k, strictSchema(v)]));
    } else {
      out[key] = strictSchema(value);
    }
  }
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    const properties = out.properties as Record<string, JsonSchema>;
    const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
    for (const [name, property] of Object.entries(properties)) {
      if (!required.has(name)) properties[name] = { anyOf: [property, { type: "null" }] };
    }
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  return out;
}

/** Drops null-valued object keys, deeply: what strict mode sends for a field the model left out. */
export function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => [k, withoutNulls(v)]),
  );
}

/**
 * OpenAI's models with your own OpenAI API key, through the Chat Completions API: Structured Outputs in strict mode
 * for the briefing's shape, `max_completion_tokens` (reasoning models refuse `max_tokens`), the reasoning effort where
 * the model takes it, and cached input counted so spend is right.
 */
export class OpenAIProvider extends OpenAICompatibleProvider {
  override readonly provider: string = "openai";

  constructor(model: string, apiKey: string, baseUrl: string = OPENAI_BASE_URL, doFetch: typeof fetch = fetch) {
    super(model, baseUrl, apiKey, doFetch);
  }

  protected override body<T>(request: GenerateRequest<T>): Record<string, unknown> {
    const effort = request.effort && OPENAI_EFFORTS[this.model]?.includes(request.effort) ? request.effort : undefined;
    return {
      model: this.model,
      max_completion_tokens: request.maxOutputTokens,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "review", schema: strictSchema(z.toJSONSchema(request.schema)), strict: true },
      },
      ...(effort ? { reasoning_effort: effort } : {}),
    };
  }

  protected override parseContent(content: string): unknown {
    return withoutNulls(JSON.parse(content));
  }

  /** prompt_tokens includes the cached tokens (and, from GPT-5.6, the ones written to the cache). */
  protected override usageOf(body: ChatCompletion): TokenUsage {
    const details = body.usage?.prompt_tokens_details;
    const cacheReadTokens = details?.cached_tokens ?? 0;
    const cacheWriteTokens = details?.cache_write_tokens ?? 0;
    return {
      inputTokens: Math.max(0, (body.usage?.prompt_tokens ?? 0) - cacheReadTokens - cacheWriteTokens),
      outputTokens: body.usage?.completion_tokens ?? 0,
      cacheReadTokens,
      cacheWriteTokens,
    };
  }

  protected override unreachable(): string {
    return "Couldn't reach api.openai.com. Check your connection (or proxy).";
  }
}
