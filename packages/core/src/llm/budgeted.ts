import { z } from "zod";
import { type BudgetLimits, checkBudget, estimateTokens } from "./budget.js";
import type { SpendLedger } from "./ledger.js";
import { costUsd, type TokenUsage, worstCaseUsd } from "./models.js";
import {
  canStream,
  type GenerateRequest,
  type GenerateResult,
  type LlmProvider,
  type StreamTextRequest,
  type StreamTextResult,
} from "./provider.js";

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

export interface BudgetedText extends StreamTextResult {
  /** What the call cost at list price; undefined when the model has no known price. */
  usd: number | undefined;
  worstCaseUsd: number | undefined;
}

/** A streamed call stopped by its signal. What it may have cost (an estimate from what arrived) is recorded. */
export class StreamStoppedError extends Error {
  constructor(readonly usd: number | undefined) {
    super("Stopped.");
    this.name = "StreamStoppedError";
  }
}

const AnswerSchema = z.object({ answer: z.string().describe("The answer, in Markdown.") });

/**
 * `budgetedGenerate` for plain text, streamed to `onText` as it's written: the same check before sending, the same
 * record after. A provider that can't stream answers in one piece. Stopped by `request.signal`, it records an estimate
 * (the input it counted and the output that arrived, since a stopped request is still billed) and throws
 * `StreamStoppedError`.
 */
export async function budgetedStreamText(
  provider: LlmProvider,
  request: StreamTextRequest,
  onText: (delta: string) => void,
  options: BudgetedOptions,
): Promise<BudgetedText> {
  const now = options.now ?? (() => new Date());
  const counted = await provider.countInputTokens({ system: request.system, user: request.user });
  const inputTokens = counted ?? estimateTokens(request.system + request.user);
  const worstCase = worstCaseUsd(provider.model, inputTokens, request.maxOutputTokens);

  const decision = checkBudget(worstCase, options.limits, await options.ledger.spentOn());
  if (!decision.ok) throw new BudgetExceededError(decision.reason, worstCase);
  if (request.signal?.aborted) throw new StreamStoppedError(undefined);

  const record = async (model: string, usage: TokenUsage) => {
    const usd = costUsd(model, usage) ?? costUsd(provider.model, usage);
    await options.ledger.record({
      at: now().toISOString(),
      provider: provider.provider,
      model,
      ...(usd === undefined ? {} : { usd }),
      usage,
      purpose: options.purpose,
    });
    return usd;
  };

  let arrived = "";
  const heard = (delta: string) => {
    arrived += delta;
    if (!request.signal?.aborted) onText(delta);
  };
  let result: StreamTextResult;
  try {
    if (canStream(provider)) {
      result = await provider.streamText(request, heard);
    } else {
      const whole = await provider.generate({
        system: request.system,
        user: request.user,
        schema: AnswerSchema,
        maxOutputTokens: request.maxOutputTokens,
        ...(request.effort ? { effort: request.effort } : {}),
      });
      const text = whole.output?.answer ?? "";
      if (text && !request.signal?.aborted) heard(text);
      result = {
        text,
        usage: whole.usage,
        stopReason: whole.output || whole.stopReason !== "end" ? whole.stopReason : "other",
        model: whole.model,
        ...(whole.refusal ? { refusal: whole.refusal } : {}),
      };
    }
  } catch (error) {
    if (request.signal?.aborted) {
      const usd = await record(provider.model, {
        inputTokens,
        outputTokens: estimateTokens(arrived),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }).catch(() => undefined);
      throw new StreamStoppedError(usd);
    }
    throw error;
  }
  const usd = await record(result.model, result.usage);
  if (request.signal?.aborted) throw new StreamStoppedError(usd);
  return { ...result, usd, worstCaseUsd: worstCase };
}
