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
 * What a call cost at list price, or undefined when Alden doesn't know the model's price (local models cost nothing
 * Alden can see; cloud-provider pricing differs and is billed by that provider).
 */
export function costUsd(model: string, usage: TokenUsage): number | undefined {
  const price = PRICES[model];
  if (!price) return undefined;
  const perToken = (perMillion: number) => perMillion / 1_000_000;
  return (
    usage.inputTokens * perToken(price.input) +
    usage.cacheReadTokens * perToken(price.input) * 0.1 +
    usage.cacheWriteTokens * perToken(price.input) * 1.25 +
    usage.outputTokens * perToken(price.output)
  );
}

/** The most a call can cost: every input token uncached, and output up to its cap. */
export function worstCaseUsd(model: string, inputTokens: number, maxOutputTokens: number): number | undefined {
  return costUsd(model, { inputTokens, outputTokens: maxOutputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
}
