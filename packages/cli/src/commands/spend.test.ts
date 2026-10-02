import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeStores, SpendLedger } from "@alden/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { renderSpend, spendReport } from "./spend.js";

let dir: string;
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alden-spend-cli-"));
});

afterEach(async () => {
  closeStores();
  await rm(dir, { recursive: true, force: true });
});

it("summarises today by model against the caps, and lists recent days", async () => {
  const ledger = new SpendLedger(join(dir, "alden.db"));
  const now = new Date().toISOString();
  const yesterday = new Date(Date.now() - 24 * 3_600_000).toISOString();
  await ledger.record({ at: now, provider: "anthropic", model: "claude-sonnet-5", usd: 0.25, usage, purpose: "a#1" });
  await ledger.record({ at: now, provider: "anthropic", model: "claude-sonnet-5", usd: 0.12, usage, purpose: "a#2" });
  await ledger.record({ at: now, provider: "openai-compatible", model: "llama3", usage, purpose: "local changes" });
  await ledger.record({
    at: yesterday,
    provider: "anthropic",
    model: "claude-opus-5",
    usd: 1.1,
    usage,
    purpose: "b#3",
  });

  const report = await spendReport(ledger, { dailyUsd: 10, perReviewUsd: 0.5 });
  expect(report.spentToday).toBeCloseTo(0.37);
  expect(report.byModel).toEqual([
    { model: "claude-sonnet-5", calls: 2, usd: expect.closeTo(0.37) },
    { model: "llama3", calls: 1, usd: null },
  ]);
  expect(report.lastDays.map((d) => d.calls)).toEqual([3, 1]);

  const text = renderSpend(report, false);
  expect(text).toContain(": $0.37 of your $10.00 daily cap · $9.63 left");
  expect(text).toMatch(/claude-sonnet-5\s+2 calls\s+\$0\.37/);
  expect(text).toMatch(/llama3\s+1 call\s+price unknown/);
  expect(text).toContain("(+1 unpriced)");
});

it("says so when nothing was spent", async () => {
  const text = renderSpend(
    await spendReport(new SpendLedger(join(dir, "alden.db")), { dailyUsd: 10, perReviewUsd: 0.5 }),
    false,
  );
  expect(text).toContain("$0.00 of your $10.00 daily cap · $10.00 left");
  expect(text).toContain("No model calls today.");
  expect(text).not.toContain("Last 7 days");
});
