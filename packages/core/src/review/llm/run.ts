import type { AldenConfig, Briefing, LlmSection } from "@alden/schema";
import type { z } from "zod";
import type { DiffFile } from "../../diff/parse.js";
import { checkLesson, checkReason, dismissKey, type Learning, noteStoppedAt, promptNotes } from "../../learn/learn.js";
import { supportsEffort } from "../../llm/anthropic.js";
import { affordableInputTokens } from "../../llm/budget.js";
import { BudgetExceededError, type BudgetedResult, budgetedGenerate } from "../../llm/budgeted.js";
import type { SpendLedger } from "../../llm/ledger.js";
import { type Effort, LlmError, type LlmErrorKind, type LlmProvider } from "../../llm/provider.js";
import { isLockfile } from "../../queue/files.js";
import { learningTarget, NOT_CHECKED } from "../briefing.js";
import { mergeLookHere } from "./merge.js";
import { buildPrompt, type LlmOutput, LlmOutputSchema, LlmOutputWithDraftsSchema } from "./prompt.js";
import { validateFindings } from "./validate.js";

/** Room for adaptive thinking plus the answer. Thinking tokens count toward the cap. */
export const MAX_OUTPUT_TOKENS = 16_000;
/**
 * When thinking uses up all of that before the answer (it happens on some PRs whatever their size), Alden asks once
 * more with low effort and this much room: plenty for an answer with little thinking, and cheap enough to fit the cap.
 */
export const RETRY_OUTPUT_TOKENS = 8_000;
/** Even when the budget allows more, bigger prompts mostly add latency. */
export const MAX_INPUT_TOKENS = 150_000;

const TITLE_CHECK = NOT_CHECKED[0] as string;

/** Why a briefing has no drafted comments though `drafts.auto` is on: the PR talks to AI reviewers. */
export const INJECTED_DRAFTS_NOTE =
  "Alden drafted no comments for this PR: it has text aimed at AI reviewers (see the check), so nothing the model wrote is offered to send under your name.";

const ERROR_NOTES: Record<LlmErrorKind, string> = {
  auth: "The model provider rejected the credentials. `alden auth status` says where the key comes from; set a new one with `alden auth model` (or check your provider's login).",
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
  /** A one-off effort, overriding `model.effort` from config. */
  effort?: Effort;
  /** Call sites of changed code, from the code graph, for the prompt. */
  callerSnippets?: string;
  /** What Alden knows about this reviewer: notes go to the model, dismissed findings stay down. */
  learning?: Learning;
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
  const effort = options.effort ?? config.model.effort;
  // Drafted comments are for a PR's review, so local changes never ask for them. A PR with text aimed at AI reviewers
  // gets none either: the model may have been steered, and a draft is text you'd send under your name.
  const injected = briefing.checks.some((c) => c.id === "injection.ai" && c.status === "flagged");
  const wantDrafts = config.drafts.auto && briefing.target.kind === "pr";
  const drafts = wantDrafts && !injected;

  const dailyLeft = config.budget.dailyUsd - (await ledger.spentOn());
  const budgetUsd = Math.min(config.budget.perReviewUsd, dailyLeft);
  const affordable = affordableInputTokens(provider.model, budgetUsd, MAX_OUTPUT_TOKENS);
  const maxInputTokens = Math.min(affordable ?? MAX_INPUT_TOKENS, MAX_INPUT_TOKENS);

  const promptFor = (inputTokens: number) =>
    buildPrompt({
      target: briefing.target,
      ...(options.description ? { description: options.description } : {}),
      files: options.files,
      checks: briefing.checks,
      maxInputTokens: inputTokens,
      ...(options.callerSnippets ? { callerSnippets: options.callerSnippets } : {}),
      reviewerNotes: promptNotes(
        options.learning,
        options.files.map((f) => f.path).filter((p) => !isLockfile(p)),
      ),
      drafts,
    });
  let prompt = promptFor(maxInputTokens);
  if (prompt.includedFiles.length === 0) {
    const note =
      dailyLeft < config.budget.perReviewUsd
        ? "Today's model budget is nearly used up, so the model wasn't asked. See `alden spend`."
        : "Even the smallest file doesn't fit the per-review budget, so the model wasn't asked.";
    return withSection(briefing, empty("over_budget", note, provider));
  }

  const purpose = briefing.target.kind === "pr" ? `${briefing.target.repo}#${briefing.target.number}` : "local changes";
  const ask = (attempt: { effort?: Effort | undefined; maxOutputTokens: number; perReviewUsd: number }) =>
    budgetedGenerate(
      provider,
      {
        system: prompt.system,
        user: prompt.user,
        // Without drafts, exactly the shape (and prompt) a review had before drafts existed.
        schema: (drafts ? LlmOutputWithDraftsSchema : LlmOutputSchema) as z.ZodType<LlmOutput>,
        maxOutputTokens: attempt.maxOutputTokens,
        ...(attempt.effort ? { effort: attempt.effort } : {}),
      },
      { limits: { ...config.budget, perReviewUsd: attempt.perReviewUsd }, ledger, purpose },
    );
  let result: BudgetedResult<LlmOutput>;
  let usedEffort = effort;
  let retryNote: string | undefined;
  try {
    result = await ask({ effort, maxOutputTokens: MAX_OUTPUT_TOKENS, perReviewUsd: config.budget.perReviewUsd });
    // Thinking ran out the room before the answer: once more with low effort, within what's left of the cap.
    if (
      !result.output &&
      result.stopReason === "max_tokens" &&
      effort !== "low" &&
      provider.provider !== "openai-compatible" &&
      supportsEffort(provider.model)
    ) {
      const first = result;
      const left = config.budget.perReviewUsd - (first.usd ?? 0);
      // A big PR's prompt may not fit twice in the cap: the retry sends what fits of it (smallest files first, as
      // always), and the briefing lists what was left out.
      const fits = affordableInputTokens(
        provider.model,
        Math.min(left, dailyLeft - (first.usd ?? 0)),
        RETRY_OUTPUT_TOKENS,
      );
      let trimmed = false;
      if (fits !== undefined && fits < maxInputTokens) {
        const smaller = promptFor(fits);
        if (smaller.includedFiles.length > 0) {
          trimmed = smaller.includedFiles.length < prompt.includedFiles.length;
          prompt = smaller;
        }
      }
      try {
        const retry = await ask({ effort: "low", maxOutputTokens: RETRY_OUTPUT_TOKENS, perReviewUsd: left });
        result = {
          ...retry,
          usd: first.usd === undefined || retry.usd === undefined ? retry.usd : first.usd + retry.usd,
        };
        usedEffort = "low";
        retryNote = trimmed
          ? "The first answer ran out of room while thinking, so Alden asked again with low effort and the files that fit what was left of your cap."
          : "The first answer ran out of room while thinking, so Alden asked again with low effort.";
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) throw error;
        retryNote = "Asking again with less thinking wouldn't fit your per-review cap.";
      }
    }
  } catch (error) {
    if (error instanceof BudgetExceededError)
      return withSection(briefing, empty("over_budget", error.message, provider));
    const kind = error instanceof LlmError ? error.kind : "other";
    // Setup errors carry their own instructions (e.g. the package to install); for the rest, the provider's detail
    // (which URL, which model, what timed out) is what makes the note actionable.
    const detail = error instanceof Error ? error.message.slice(0, 200) : "";
    const note =
      kind === "setup" ? detail : kind === "auth" || !detail ? ERROR_NOTES[kind] : `${ERROR_NOTES[kind]} (${detail})`;
    return withSection(briefing, empty("failed", note, provider));
  }

  const base = {
    provider: provider.provider,
    model: result.model,
    ...(usedEffort && provider.provider !== "openai-compatible" && supportsEffort(result.model)
      ? { effort: usedEffort }
      : {}),
    omittedFiles: prompt.omittedFiles,
    ...(prompt.redactedSecrets > 0 ? { redactedSecrets: prompt.redactedSecrets } : {}),
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
        ? `The model's answer was cut off before it finished, so it was discarded.${retryNote ? ` ${retryNote}` : ""}`
        : "The model's answer didn't match the expected format, so it was discarded.";
    return withSection(briefing, { ...base, status, note, findings: [], droppedFindings: 0 });
  }

  const shown = options.files.filter((f) => prompt.includedFiles.includes(f.path));
  const validated = validateFindings(result.output, shown, prompt.notes, { drafts });
  const { dropped } = validated;
  // A finding you dismissed on this PR stays down when a re-review raises it again.
  const target = learningTarget(briefing.target);
  const dismissedOn = (f: (typeof validated.findings)[number]) =>
    options.learning &&
    [f.anchors[0]?.path, ...f.anchors.map((a) => a.path)]
      .map((path) =>
        options.learning?.dismissed.get(
          dismissKey(target, { source: "llm", title: f.title, anchor: path ? { path } : undefined }),
        ),
      )
      .find(Boolean);
  // A finding from a note you stopped applying everywhere it points stays out too (the prompt told the model).
  const stoppedAt = (f: (typeof validated.findings)[number]) =>
    f.fromNote
      ? noteStoppedAt(
          options.learning,
          f.fromNote.id,
          f.anchors.map((a) => a.path),
        )
      : undefined;
  const kept = validated.findings.filter((f) => !dismissedOn(f) && !stoppedAt(f));
  const hiddenFindings = validated.findings.flatMap((f) => {
    const at = dismissedOn(f);
    const stopped = at ? undefined : stoppedAt(f);
    const reason = at
      ? `You dismissed it on ${at.slice(0, 10)}`
      : stopped
        ? `You stopped applying the note it came from to ${stopped}`
        : undefined;
    return reason ? [{ title: f.title, reason, ...(f.anchors[0] ? { anchor: f.anchors[0] } : {}) }] : [];
  });
  // A finding on a topic your feedback quietened stays in the model's list but takes no place to look, unless it's
  // high severity: the same rule as the check's own flags.
  const quietLesson = (f: (typeof kept)[number]) => {
    const lesson = f.checkId && f.severity !== "high" ? checkLesson(options.learning, f.checkId) : undefined;
    return lesson?.direction === "down" ? lesson : undefined;
  };
  // Nor does Alden draft a comment on it.
  const findings = kept.map((f) => {
    if (!f.draft || !quietLesson(f)) return f;
    const { draft: _draft, ...rest } = f;
    return rest;
  });
  const quietFindings = findings.flatMap((f) => {
    const lesson = quietLesson(f);
    return lesson
      ? [{ title: f.title, reason: checkReason(lesson), ...(f.anchors[0] ? { anchor: f.anchors[0] } : {}) }]
      : [];
  });
  const notes = prompt.reviewerNotes;
  const hidden = [...(briefing.learning?.hidden ?? []), ...hiddenFindings, ...quietFindings];
  const quietened = briefing.learning?.quietened ?? [];
  return {
    ...briefing,
    ...(hidden.length > 0 || notes > 0 || quietened.length > 0
      ? { learning: { hidden, ...(quietened.length > 0 ? { quietened } : {}), memory: notes } }
      : {}),
    needsYourEyes: mergeLookHere(
      briefing.needsYourEyes,
      briefing.checks,
      findings.filter((f) => !quietLesson(f)),
      config.review.eyes,
    ),
    notChecked: [
      ...briefing.notChecked.filter((item) => item !== TITLE_CHECK),
      ...prompt.omittedFiles.map((path) => `${path}: left out of the model's view to fit the budget`),
    ],
    llm: {
      ...base,
      status: "ok",
      ...(retryNote ? { note: retryNote } : {}),
      summary: result.output.summary,
      matchesTitle: result.output.matchesTitle,
      findings,
      droppedFindings: dropped,
      ...(wantDrafts && injected ? { draftsNote: INJECTED_DRAFTS_NOTE } : {}),
    },
  };
}
