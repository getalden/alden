import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { closeStores } from "../store/db.js";
import { affordableInputTokens, checkBudget, estimateTokens } from "./budget.js";
import { BudgetExceededError, budgetedGenerate } from "./budgeted.js";
import { localDay, SpendLedger } from "./ledger.js";
import type { GenerateRequest, GenerateResult, LlmProvider } from "./provider.js";

const limits = { perReviewUsd: 0.5, dailyUsd: 10 };

describe("checkBudget", () => {
  it("allows calls within both caps", () => {
    expect(checkBudget(0.2, limits, 3)).toEqual({ ok: true, worstCaseUsd: 0.2 });
  });

  it("refuses a call over the per-review cap and says how to raise it", () => {
    const decision = checkBudget(0.8, limits, 0);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toContain("up to $0.80, over your $0.50 per-review cap");
      expect(decision.reason).toContain("alden config set budget.perReviewUsd");
    }
  });

  it("refuses a call that would pass today's cap", () => {
    const decision = checkBudget(0.3, limits, 9.8);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain("$9.80 of your $10.00 daily cap");
  });

  it("always allows calls it can't price", () => {
    expect(checkBudget(undefined, limits, 999).ok).toBe(true);
  });
});

describe("affordableInputTokens", () => {
  it("leaves room for the output cap", () => {
    // Sonnet 5: 8,000 output tokens cost $0.08, leaving $0.42 for input at $2/M = 210,000 tokens.
    expect(affordableInputTokens("claude-sonnet-5", 0.5, 8000)).toBe(210_000);
    expect(affordableInputTokens("claude-sonnet-5", 0.05, 8000)).toBe(0);
    expect(affordableInputTokens("llama3", 0.5, 8000)).toBeUndefined();
  });

  it("estimates about three characters per token", () => {
    expect(estimateTokens("x".repeat(300))).toBe(100);
  });
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alden-spend-"));
});

afterEach(async () => {
  closeStores();
  await rm(dir, { recursive: true, force: true });
});

describe("SpendLedger", () => {
  const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };

  it("appends entries per local day and totals known spending", async () => {
    const ledger = new SpendLedger(join(dir, "alden.db"));
    const at = new Date(2026, 8, 29, 23, 30).toISOString();
    await ledger.record({ at, provider: "anthropic", model: "claude-sonnet-5", usd: 0.12, usage, purpose: "a#1" });
    await ledger.record({ at, provider: "anthropic", model: "claude-sonnet-5", usd: 0.03, usage, purpose: "a#2" });
    await ledger.record({ at, provider: "openai-compatible", model: "llama3", usage, purpose: "local changes" });

    expect(await ledger.entries("2026-09-29")).toHaveLength(3);
    expect(await ledger.spentOn("2026-09-29")).toBeCloseTo(0.15);
    expect(await ledger.spentOn("2026-09-30")).toBe(0);
    expect(await ledger.days()).toEqual(["2026-09-29"]);
  });

  it("imports the old JSON-lines ledger, skipping a half-written line", async () => {
    await mkdir(join(dir, "spend"));
    await writeFile(
      join(dir, "spend", "2026-09-29.jsonl"),
      '{"at":"2026-09-29T12:00:00","usd":0.5,"model":"m","usage":{}}\n{"usd":0.2,"mod',
    );
    expect(await new SpendLedger(join(dir, "alden.db")).spentOn("2026-09-29")).toBe(0.5);
  });

  it("formats local days", () => {
    expect(localDay(new Date(2026, 0, 5, 0, 1))).toBe("2026-01-05");
  });
});

describe("budgetedGenerate", () => {
  const Out = z.object({ summary: z.string() });
  const request: GenerateRequest<{ summary: string }> = {
    system: "sys",
    user: "diff",
    schema: Out,
    maxOutputTokens: 8000,
  };

  function provider(
    opts: {
      inputTokens?: number | undefined;
      model?: string;
      result?: Partial<GenerateResult<{ summary: string }>>;
    } = {},
  ) {
    let calls = 0;
    const p: LlmProvider = {
      provider: "anthropic",
      model: opts.model ?? "claude-sonnet-5",
      countInputTokens: async () => opts.inputTokens,
      generate: async <T>() => {
        calls++;
        return {
          output: { summary: "ok" },
          usage: { inputTokens: 20_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "end",
          model: opts.model ?? "claude-sonnet-5",
          ...opts.result,
        } as GenerateResult<T>;
      },
    };
    return { p, calls: () => calls };
  }

  it("calls the model and records what it actually cost", async () => {
    const ledger = new SpendLedger(join(dir, "alden.db"));
    const { p } = provider({ inputTokens: 20_000 });
    const result = await budgetedGenerate(p, request, { limits, ledger, purpose: "getalden/alden#12" });

    // Actual: 20k in at $2/M + 1k out at $10/M = $0.05. Worst case: 20k in + 8k out = $0.12.
    expect(result.usd).toBeCloseTo(0.05);
    expect(result.worstCaseUsd).toBeCloseTo(0.12);
    const [entry] = await ledger.entries();
    expect(entry).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5", purpose: "getalden/alden#12" });
    expect(entry?.usd).toBeCloseTo(0.05);
  });

  it("refuses before sending when the worst case breaks the per-review cap", async () => {
    const { p, calls } = provider({ inputTokens: 300_000 });
    await expect(
      budgetedGenerate(p, request, { limits, ledger: new SpendLedger(join(dir, "alden.db")), purpose: "x" }),
    ).rejects.toThrow(BudgetExceededError);
    expect(calls()).toBe(0);
  });

  it("refuses before sending when today's spend would pass the daily cap", async () => {
    const ledger = new SpendLedger(join(dir, "alden.db"));
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    await ledger.record({
      at: new Date().toISOString(),
      provider: "anthropic",
      model: "m",
      usd: 9.95,
      usage,
      purpose: "earlier",
    });
    const { p, calls } = provider({ inputTokens: 20_000 });
    await expect(budgetedGenerate(p, request, { limits, ledger, purpose: "x" })).rejects.toThrow(/daily cap/);
    expect(calls()).toBe(0);
  });

  it("estimates input when the provider can't count, and records unknown prices without a cost", async () => {
    const ledger = new SpendLedger(join(dir, "alden.db"));
    const { p } = provider({ inputTokens: undefined, model: "llama3" });
    const result = await budgetedGenerate(p, request, { limits, ledger, purpose: "local changes" });
    expect(result.usd).toBeUndefined();
    const [entry] = await ledger.entries();
    expect(entry).not.toHaveProperty("usd");
  });

  it("records refusals, since they can be billed", async () => {
    const ledger = new SpendLedger(join(dir, "alden.db"));
    const { p } = provider({ inputTokens: 1000, result: { output: null, stopReason: "refusal" } });
    await budgetedGenerate(p, request, { limits, ledger, purpose: "x" });
    expect(await ledger.entries()).toHaveLength(1);
  });
});
