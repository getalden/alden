import { type BudgetLimits, checkBudget, estimateTokens } from "./budget.js";
import type { SpendLedger } from "./ledger.js";
import { costUsd, worstCaseUsd } from "./models.js";
import type { GenerateRequest, GenerateResult, LlmProvider } from "./provider.js";

/** A call that would break a budget. Nothing was sent to the model. */
export class BudgetExceededError extends Error {
  constructor(
    message: string,
    readonly worstCaseUsd: number | undefined,
  ) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export interface BudgetedResult<T> extends GenerateResult<T> {
  /** What the call cost at list price; undefined when the model has no known price. */
  usd: number | undefined;
  /** What it could have cost at most, as checked before sending. */
  worstCaseUsd: number | undefined;
}

export interface BudgetedOptions {
  limits: BudgetLimits;
  ledger: SpendLedger;
  /** Recorded with the spend, e.g. "getalden/alden#12". */
  purpose: string;
  now?: () => Date;
}

/**
 * The only way Alden calls a model: count the input (or estimate it), refuse if the worst case breaks the per-review
 * or daily cap, then call and record what it actually cost, refusals included, since those can be billed too.
 */
export async function budgetedGenerate<T>(
  provider: LlmProvider,
  request: GenerateRequest<T>,
  options: BudgetedOptions,
): Promise<BudgetedResult<T>> {
  const now = options.now ?? (() => new Date());
  const counted = await provider.countInputTokens({ system: request.system, user: request.user });
  const inputTokens = counted ?? estimateTokens(request.system + request.user);
  const worstCase = worstCaseUsd(provider.model, inputTokens, request.maxOutputTokens);

  const decision = checkBudget(worstCase, options.limits, await options.ledger.spentOn());
  if (!decision.ok) throw new BudgetExceededError(decision.reason, worstCase);

  const result = await provider.generate(request);
  const usd = costUsd(result.model, result.usage) ?? costUsd(provider.model, result.usage);
  await options.ledger.record({
    at: now().toISOString(),
    provider: provider.provider,
    model: result.model,
    ...(usd === undefined ? {} : { usd }),
    usage: result.usage,
    purpose: options.purpose,
  });
  return { ...result, usd, worstCaseUsd: worstCase };
}
