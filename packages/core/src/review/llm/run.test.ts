import { mkdtemp, readFileSync, rm } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AldenConfigSchema, BriefingSchema, type CheckResult, type LookHere } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromRestFile } from "../../diff/sources.js";
import { type RawPullRequest, toFacts } from "../../github/pull-requests.js";
import { SpendLedger } from "../../llm/ledger.js";
import { type GenerateResult, LlmError, type LlmProvider } from "../../llm/provider.js";
import { buildBriefing } from "../briefing.js";
import { mergeLookHere } from "./merge.js";
import type { LlmOutput } from "./prompt.js";
import { addModelReview } from "./run.js";

const FIXTURES = join(import.meta.dirname, "../../github/__fixtures__");
const config = AldenConfigSchema.parse({});

/** A recorded real PR with its diff, as a deterministic briefing. */
function recorded(name: string, number: number) {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as {
    pullRequests: RawPullRequest[];
  };
  const raw = fixture.pullRequests.find((p) => p.number === number) as RawPullRequest;
  const files = (
    JSON.parse(readFileSync(join(FIXTURES, "diffs", `${name}-${number}.json`), "utf8")) as Parameters<
      typeof fromRestFile
    >[0][]
  ).map(fromRestFile);
  const pr = toFacts(raw, { login: "someone", teams: new Set() });
  const briefing = buildBriefing({
    target: {
      kind: "pr",
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
      title: pr.title,
      author: pr.author,
      baseRef: pr.baseRef,
      headRef: pr.headRef,
    },
    files,
    pr,
    config,
    manifests: [],
  });
  return { briefing, files };
}

/** A stand-in model that returns `output` (or fails as told) and records what it was sent. */
function model(behaviour: Partial<GenerateResult<LlmOutput>> | Error, inputTokens = 10_000) {
  const sent: string[] = [];
  const provider: LlmProvider = {
    provider: "anthropic",
    model: "claude-sonnet-5",
    countInputTokens: async () => inputTokens,
    generate: async <T>(request: { user: string }) => {
      sent.push(request.user);
      if (behaviour instanceof Error) throw behaviour;
      return {
        output: null,
        usage: { inputTokens, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end",
        model: "claude-sonnet-5",
        ...behaviour,
      } as GenerateResult<T>;
    },
  };
  return { provider, sent };
}

let dir: string;
beforeEach(async () => {
  dir = await new Promise<string>((resolve, reject) =>
    mkdtemp(join(tmpdir(), "alden-llm-"), (err, path) => (err ? reject(err) : resolve(path))),
  );
});
afterEach(() => rm(dir, { recursive: true, force: true }, () => {}));

describe("addModelReview on a real PR", () => {
  it("adds the model's view, keeps only real locations, and records the spend", async () => {
    // grafana#133736 changes fetchCatalog's return type at metricResourceClient.ts:191.
    const { briefing, files } = recorded("grafana", 133736);
    const path = "public/app/features/explore/SignalExplorer/data/metricResourceClient.ts";
    const { provider, sent } = model({
      output: {
        summary: "Searches the whole metric catalog server-side instead of only loaded metrics.",
        matchesTitle: { verdict: "yes", reason: "The catalog fetch is now server-side." },
        findings: [
          {
            title: "fetchCatalog callers must handle Catalog",
            detail: "The return type changed.",
            severity: "high",
            anchors: [{ path, line: 191 }],
          },
          {
            title: "Invented",
            detail: "Points nowhere real.",
            severity: "high",
            anchors: [{ path: "src/nope.ts", line: 4 }],
          },
          { title: "Naming nit", detail: "Minor.", severity: "low", anchors: [{ path }] },
        ],
      },
    });
    const ledger = new SpendLedger(dir);
    const result = await addModelReview(briefing, {
      provider,
      config,
      ledger,
      files,
      description: "Server-side search.",
    });

    expect(sent[0]).toContain("## Description\nServer-side search.");
    expect(result.llm).toMatchObject({ status: "ok", model: "claude-sonnet-5", droppedFindings: 1, omittedFiles: [] });
    expect(result.llm?.findings.map((f) => f.title)).toEqual([
      "fetchCatalog callers must handle Catalog",
      "Naming nit",
    ]);
    expect(result.llm?.usd).toBeCloseTo(0.04); // 10k in at $2/M + 2k out at $10/M
    expect(result.needsYourEyes[0]).toMatchObject({
      title: "fetchCatalog callers must handle Catalog",
      source: "llm",
      anchor: { path, line: 191 },
    });
    expect(result.notChecked.some((n) => n.startsWith("Whether the change does what its title says"))).toBe(false);
    expect(await ledger.entries()).toHaveLength(1);
    expect(BriefingSchema.safeParse(JSON.parse(JSON.stringify(result))).error).toBeUndefined();
  });

  it.each([
    [
      "a refusal",
      { output: null, stopReason: "refusal" as const, refusal: { category: "cyber", explanation: null } },
      "refused",
      /declined.*\(cyber\)/,
    ],
    ["a cut-off answer", { output: null, stopReason: "max_tokens" as const }, "truncated", /cut off/],
    ["an unusable answer", { output: null, stopReason: "end" as const }, "failed", /format/],
    ["an auth error", new LlmError("auth", "401"), "failed", /credentials/],
    ["a network error", new LlmError("network", "offline"), "failed", /reach/],
  ])("keeps the deterministic briefing after %s", async (_label, behaviour, status, note) => {
    const { briefing, files } = recorded("django", 22041);
    const result = await addModelReview(briefing, {
      provider: model(behaviour).provider,
      config,
      ledger: new SpendLedger(dir),
      files,
    });
    expect(result.llm?.status).toBe(status);
    expect(result.llm?.note).toMatch(note);
    expect(result.needsYourEyes).toEqual(briefing.needsYourEyes);
    expect(result.checks).toEqual(briefing.checks);
  });

  it("stops before calling when the budget can't cover the review", async () => {
    const { briefing, files } = recorded("django", 22041);
    const { provider, sent } = model({}, 400_000);
    const result = await addModelReview(briefing, { provider, config, ledger: new SpendLedger(dir), files });
    expect(result.llm).toMatchObject({ status: "over_budget", note: expect.stringMatching(/per-review cap/) });
    expect(sent).toHaveLength(0);
  });

  it("says so when today's budget is nearly gone", async () => {
    const { briefing, files } = recorded("django", 22041);
    const ledger = new SpendLedger(dir);
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    await ledger.record({
      at: new Date().toISOString(),
      provider: "anthropic",
      model: "m",
      usd: 9.9,
      usage,
      purpose: "x",
    });
    const result = await addModelReview(briefing, { provider: model({}).provider, config, ledger, files });
    expect(result.llm).toMatchObject({ status: "over_budget", note: expect.stringMatching(/nearly used up/) });
  });
});

describe("mergeLookHere", () => {
  const check = (id: string, severity: CheckResult["severity"]): CheckResult => ({
    id,
    title: id,
    status: "flagged",
    severity,
    summary: "",
    evidence: [],
    heuristic: false,
  });
  const item = (checkId: string, path: string): LookHere => ({
    title: checkId,
    reason: "r",
    anchor: { path, line: 1 },
    checkId,
  });
  const finding = (title: string, severity: "low" | "medium" | "high", paths: string[]) => ({
    title,
    detail: "d",
    severity,
    anchors: paths.map((path) => ({ path, line: 2 })),
  });

  it("keeps high-severity checks first, then the model's findings, then the other checks", () => {
    const checks = [check("secrets.likely", "high"), check("tests.missing", "medium")];
    const merged = mergeLookHere([item("secrets.likely", "keys.ts"), item("tests.missing", "a.ts")], checks, [
      finding("Race in retry", "medium", ["b.ts"]),
      finding("Style", "low", ["c.ts"]),
    ]);
    expect(merged.map((m) => [m.title, m.source])).toEqual([
      ["secrets.likely", "check"],
      ["Race in retry", "llm"],
      ["tests.missing", "check"],
    ]);
  });

  it("gives a finding repeated across files one slot that says so", () => {
    const merged = mergeLookHere(
      [],
      [],
      [finding("Same runner bump in every workflow", "medium", ["w1.yml", "w2.yml", "w3.yml"])],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.reason).toBe("d (and 2 more places)");
  });

  it("never gives one file two slots", () => {
    const merged = mergeLookHere(
      [item("tests.missing", "a.ts")],
      [check("tests.missing", "medium")],
      [finding("Bug", "high", ["a.ts"])],
    );
    expect(merged.map((m) => m.title)).toEqual(["Bug"]);
  });
});
