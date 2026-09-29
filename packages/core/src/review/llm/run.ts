import type { AldenConfig, Briefing, LlmSection } from "@alden/schema";
import type { DiffFile } from "../../diff/parse.js";
import { affordableInputTokens } from "../../llm/budget.js";
import { BudgetExceededError, type BudgetedResult, budgetedGenerate } from "../../llm/budgeted.js";
import type { SpendLedger } from "../../llm/ledger.js";
import { LlmError, type LlmErrorKind, type LlmProvider } from "../../llm/provider.js";
import { NOT_CHECKED } from "../briefing.js";
import { mergeLookHere } from "./merge.js";
import { buildPrompt, type LlmOutput, LlmOutputSchema } from "./prompt.js";
import { validateFindings } from "./validate.js";

/** Room for adaptive thinking plus the answer. Thinking tokens count toward the cap. */
export const MAX_OUTPUT_TOKENS = 16_000;
/** Even when the budget allows more, bigger prompts mostly add latency. */
export const MAX_INPUT_TOKENS = 150_000;

const TITLE_CHECK = NOT_CHECKED[0] as string;

const ERROR_NOTES: Record<LlmErrorKind, string> = {
  auth: "The model provider rejected the credentials. Check ANTHROPIC_API_KEY (or your provider's login).",
  rate_limit: "The model provider is rate-limiting this key. Try again in a minute.",
  overloaded: "The model provider is overloaded or erroring. Try again shortly.",
  bad_request: "The model provider rejected the request.",
  not_found: "The configured model wasn't found. Check `alden config get model.name`.",
  network: "Couldn't reach the model provider. Check your connection.",
  setup: "The model provider isn't set up.",
  other: "The model call failed.",
};

export interface ModelReviewOptions {
  provider: LlmProvider;
  config: AldenConfig;
  ledger: SpendLedger;
  /** The PR description, for judging whether the change does what it says. */
  description?: string;
  /** The files the briefing was built from, with hunks. */
  files: DiffFile[];
}

function withSection(briefing: Briefing, llm: LlmSection): Briefing {
  return { ...briefing, llm };
}

const empty = (status: LlmSection["status"], note: string, provider: LlmProvider): LlmSection => ({
  status,
  note,
  provider: provider.provider,
  model: provider.model,
  findings: [],
  droppedFindings: 0,
  omittedFiles: [],
});

/**
 * Adds the model's view to a deterministic briefing. Never throws: a refusal, a budget stop, a network error or a
 * truncated answer becomes a status with a one-line note, and the deterministic briefing stands unchanged.
 */
export async function addModelReview(briefing: Briefing, options: ModelReviewOptions): Promise<Briefing> {
  const { provider, config, ledger } = options;
  if (options.files.length === 0) return briefing;

  const dailyLeft = config.budget.dailyUsd - (await ledger.spentOn());
  const budgetUsd = Math.min(config.budget.perReviewUsd, dailyLeft);
  const affordable = affordableInputTokens(provider.model, budgetUsd, MAX_OUTPUT_TOKENS);
  const maxInputTokens = Math.min(affordable ?? MAX_INPUT_TOKENS, MAX_INPUT_TOKENS);

  const prompt = buildPrompt({
    target: briefing.target,
    ...(options.description ? { description: options.description } : {}),
    files: options.files,
    checks: briefing.checks,
    maxInputTokens,
  });
  if (prompt.includedFiles.length === 0) {
    const note =
      dailyLeft < config.budget.perReviewUsd
        ? "Today's model budget is nearly used up, so the model wasn't asked. See `alden spend`."
        : "Even the smallest file doesn't fit the per-review budget, so the model wasn't asked.";
    return withSection(briefing, empty("over_budget", note, provider));
  }

  const purpose = briefing.target.kind === "pr" ? `${briefing.target.repo}#${briefing.target.number}` : "local changes";
  let result: BudgetedResult<LlmOutput>;
  try {
    result = await budgetedGenerate(
      provider,
      { system: prompt.system, user: prompt.user, schema: LlmOutputSchema, maxOutputTokens: MAX_OUTPUT_TOKENS },
      { limits: config.budget, ledger, purpose },
    );
  } catch (error) {
    if (error instanceof BudgetExceededError)
      return withSection(briefing, empty("over_budget", error.message, provider));
    const kind = error instanceof LlmError ? error.kind : "other";
    // Setup errors carry their own instructions (e.g. the package to install); for others the provider's detail
    // (which URL, which model) is what makes the note actionable.
    const detail = error instanceof Error ? error.message.slice(0, 200) : "";
    const note =
      kind === "setup"
        ? detail
        : kind === "network" || kind === "not_found" || kind === "bad_request"
          ? `${ERROR_NOTES[kind]} (${detail})`
          : ERROR_NOTES[kind];
    return withSection(briefing, empty("failed", note, provider));
  }

  const base = {
    provider: provider.provider,
    model: result.model,
    omittedFiles: prompt.omittedFiles,
    ...(result.usd === undefined ? {} : { usd: result.usd }),
  };
  if (result.stopReason === "refusal") {
    const category = result.refusal?.category ? ` (${result.refusal.category})` : "";
    return withSection(briefing, {
      ...base,
      status: "refused",
      note: `The model declined to review this change${category}. The checks above still apply.`,
      findings: [],
      droppedFindings: 0,
    });
  }
  if (!result.output) {
    const status = result.stopReason === "max_tokens" ? "truncated" : "failed";
    const note =
      status === "truncated"
        ? "The model's answer was cut off before it finished, so it was discarded."
        : "The model's answer didn't match the expected format, so it was discarded.";
    return withSection(briefing, { ...base, status, note, findings: [], droppedFindings: 0 });
  }

  const shown = options.files.filter((f) => prompt.includedFiles.includes(f.path));
  const { findings, dropped } = validateFindings(result.output, shown);
  return {
    ...briefing,
    needsYourEyes: mergeLookHere(briefing.needsYourEyes, briefing.checks, findings),
    notChecked: [
      ...briefing.notChecked.filter((item) => item !== TITLE_CHECK),
      ...prompt.omittedFiles.map((path) => `${path}: left out of the model's view to fit the budget`),
    ],
    llm: {
      ...base,
      status: "ok",
      summary: result.output.summary,
      matchesTitle: result.output.matchesTitle,
      findings,
      droppedFindings: dropped,
    },
  };
}
