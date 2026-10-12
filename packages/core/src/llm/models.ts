/** Short names people type (`alden config set model.name opus`) and the Claude model each one means. */
export const MODEL_ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5",
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5-1",
};

/** Anthropic list prices in USD per million tokens. Cache reads bill at 0.1x input, 5-minute cache writes at 1.25x. */
export const PRICES: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/**
 * OpenAI list prices in USD per million tokens (Standard tier, prompts under 272K tokens), from
 * https://developers.openai.com/api/docs/pricing, checked 12 October 2026. `cachedInput` is the cached-input rate;
 * `cacheWrite` the rate for writing the cache, which GPT-5.6 and later bill at 1.25x input and earlier models don't
 * bill extra. Only the models Alden offers, and the earlier ones people are likely to have set; others have no known
 * price, so their spend isn't counted (the same as a local model). Verify against the page when adding a model.
 */
export const OPENAI_PRICES: Record<string, ModelPrice> = {
  "gpt-6-astra": { input: 10, output: 50, cachedInput: 1, cacheWrite: 12.5 },
  "gpt-6.1-sol": { input: 2, output: 10, cachedInput: 0.1, cacheWrite: 2.5 },
  "gpt-6-sol": { input: 2, output: 10, cachedInput: 0.2, cacheWrite: 2.5 },
  "gpt-6-luna": { input: 0.1, output: 0.5, cachedInput: 0.01, cacheWrite: 0.125 },
  "gpt-5.6-sol": { input: 4, output: 20, cachedInput: 0.4, cacheWrite: 5 },
  "gpt-5.6-terra": { input: 2, output: 12, cachedInput: 0.2, cacheWrite: 2.5 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cachedInput: 0.02, cacheWrite: 0.25 },
  "gpt-5.5": { input: 5, output: 30, cachedInput: 0.5, cacheWrite: 5 },
  "gpt-5.4": { input: 2.5, output: 15, cachedInput: 0.25, cacheWrite: 2.5 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cachedInput: 0.075, cacheWrite: 0.75 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cachedInput: 0.02, cacheWrite: 0.2 },
  "gpt-5.2": { input: 1.75, output: 14, cachedInput: 0.175, cacheWrite: 1.75 },
  "gpt-5.1": { input: 1.25, output: 10, cachedInput: 0.125, cacheWrite: 1.25 },
  "gpt-5": { input: 1.25, output: 10, cachedInput: 0.125, cacheWrite: 1.25 },
  "gpt-5-mini": { input: 0.25, output: 2, cachedInput: 0.025, cacheWrite: 0.25 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cachedInput: 0.005, cacheWrite: 0.05 },
  "gpt-4.1": { input: 2, output: 8, cachedInput: 0.5, cacheWrite: 2 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cachedInput: 0.1, cacheWrite: 0.4 },
};

/** A model's list price per million tokens. Without cache rates, Anthropic's apply: reads 0.1x input, writes 1.25x. */
export interface ModelPrice {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite?: number;
}

/** A model name from config: an alias, or passed through as-is (full Claude IDs, local model names). */
export function resolveModel(name: string): string {
  return MODEL_ALIASES[name.trim().toLowerCase()] ?? name.trim();
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const NO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * List price for a Claude model on any platform. Bedrock IDs carry an "anthropic." prefix. Bedrock and Vertex bill at
 * their own rates, so there it's an estimate; Foundry bills at Anthropic's.
 */
export function priceFor(model: string): ModelPrice | undefined {
  const claude = PRICES[model.replace(/^anthropic\./, "")];
  if (claude) return claude;
  // OpenAI answers with a dated snapshot, e.g. gpt-5-2025-08-07, priced as its model.
  return OPENAI_PRICES[model] ?? OPENAI_PRICES[model.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
}

/**
 * What a call cost at list price, or undefined when Alden doesn't know the model's price (local models cost nothing
 * Alden can see).
 */
export function costUsd(model: string, usage: TokenUsage): number | undefined {
  const price = priceFor(model);
  if (!price) return undefined;
  const perToken = (perMillion: number) => perMillion / 1_000_000;
  return (
    usage.inputTokens * perToken(price.input) +
    usage.cacheReadTokens * perToken(price.cachedInput ?? price.input * 0.1) +
    usage.cacheWriteTokens * perToken(price.cacheWrite ?? price.input * 1.25) +
    usage.outputTokens * perToken(price.output)
  );
}

/** The most a call can cost: every input token uncached, and output up to its cap. */
export function worstCaseUsd(model: string, inputTokens: number, maxOutputTokens: number): number | undefined {
  return costUsd(model, { inputTokens, outputTokens: maxOutputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
}
