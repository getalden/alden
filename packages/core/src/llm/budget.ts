import { priceFor } from "./models.js";

export interface BudgetLimits {
  perReviewUsd: number;
  dailyUsd: number;
}

export type BudgetDecision =
  | { ok: true; worstCaseUsd: number | undefined }
  | { ok: false; reason: string; worstCaseUsd: number | undefined };

const usd = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

/**
 * Whether a call may run: its worst case (every input token uncached, output up to its cap) must fit both the
 * per-review cap and what's left of today's. Calls Alden can't price (local models) always run.
 */
export function checkBudget(
  worstCaseUsd: number | undefined,
  limits: BudgetLimits,
  spentToday: number,
): BudgetDecision {
  if (worstCaseUsd === undefined) return { ok: true, worstCaseUsd };
  if (worstCaseUsd > limits.perReviewUsd) {
    return {
      ok: false,
      worstCaseUsd,
      reason: `This review could cost up to ${usd(worstCaseUsd)}, over your ${usd(limits.perReviewUsd)} per-review cap. Raise it with \`alden config set budget.perReviewUsd <amount>\`.`,
    };
  }
  const left = limits.dailyUsd - spentToday;
  if (worstCaseUsd > left) {
    return {
      ok: false,
      worstCaseUsd,
      reason: `Today's spend is ${usd(spentToday)} of your ${usd(limits.dailyUsd)} daily cap, and this review could cost up to ${usd(worstCaseUsd)}. It resets at midnight, or raise it with \`alden config set budget.dailyUsd <amount>\`.`,
    };
  }
  return { ok: true, worstCaseUsd };
}

/**
 * The most input tokens a review can send and still fit `budgetUsd` with `maxOutputTokens` of output. Undefined when
 * the model has no known price (no limit from cost), 0 when even the output alone doesn't fit.
 */
export function affordableInputTokens(model: string, budgetUsd: number, maxOutputTokens: number): number | undefined {
  const price = priceFor(model);
  if (!price) return undefined;
  const outputCost = (maxOutputTokens * price.output) / 1_000_000;
  const left = budgetUsd - outputCost;
  if (left <= 0) return 0;
  return Math.floor((left * 1_000_000) / price.input);
}

/** When a provider can't count tokens, a conservative estimate: about 3 characters per token for code. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
