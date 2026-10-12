import { mkdtemp, readFileSync, rm } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AldenConfigSchema, BriefingSchema, type CheckResult, type LookHere } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromRestFile } from "../../diff/sources.js";
import { type RawPullRequest, toFacts } from "../../github/pull-requests.js";
import { learn } from "../../learn/learn.js";
import { SpendLedger } from "../../llm/ledger.js";
import { type GenerateResult, LlmError, type LlmProvider } from "../../llm/provider.js";
import { closeStores } from "../../store/db.js";
import { buildBriefing } from "../briefing.js";
import { mergeLookHere } from "./merge.js";
import { type LlmOutput, LlmOutputSchema, LlmOutputWithDraftsSchema, SYSTEM_PROMPT, systemPrompt } from "./prompt.js";
import { addModelReview, DRAFTS_OFF_NOTE, INJECTED_DRAFTS_NOTE, NONE_DRAFTED_NOTE, NONE_TO_DRAFT_NOTE } from "./run.js";

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
afterEach(() => {
  closeStores();
  rm(dir, { recursive: true, force: true }, () => {});
});

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
    const ledger = new SpendLedger(join(dir, "alden.db"));
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

  it("tags findings with a check topic, and keeps a quietened topic's findings out of the places to look", async () => {
    const { briefing, files } = recorded("grafana", 133736);
    const path = "public/app/features/explore/SignalExplorer/data/metricResourceClient.ts";
    const { provider, sent } = model({
      output: {
        summary: "s",
        matchesTitle: { verdict: "yes", reason: "r" },
        findings: [
          { title: "No test for the new path", detail: "d", severity: "medium", anchors: [{ path }], topic: "tests" },
          { title: "Callers break", detail: "d", severity: "medium", anchors: [{ path, line: 191 }], topic: "api" },
        ],
      },
    });
    const verdict = (number: number) => ({
      schemaVersion: 1 as const,
      id: `v${number}`,
      at: "2026-09-20T12:00:00.000Z",
      kind: "verdict" as const,
      target: { kind: "pr" as const, repo: "acme/shop", number },
      briefingAt: "2026-09-20T12:00:00.000Z",
      item: { source: "check" as const, checkId: "tests.missing", title: "t", placement: "eyes" as const },
      verdict: "not_needed" as const,
    });
    const learning = learn({ repo: "acme/shop", feedback: [1, 2, 3].map(verdict), opens: [], memory: [] });
    const result = await addModelReview(briefing, {
      provider,
      config,
      ledger: new SpendLedger(join(dir, "alden.db")),
      files,
      learning,
    });
    expect(sent[0]).toContain(
      "Usually finds untested-change concerns not useful: raise them only when they're serious.",
    );
    expect(result.llm?.findings.map((f) => f.checkId)).toEqual(["tests.missing", "signatures.changed"]);
    expect(result.needsYourEyes.find((e) => e.title === "Callers break")).toMatchObject({
      checkId: "signatures.changed",
    });
    expect(result.needsYourEyes.some((e) => e.title === "No test for the new path")).toBe(false);
    expect(result.learning?.hidden).toContainEqual({
      title: "No test for the new path",
      reason: "You usually mark untested-change flags not useful (3 of 3)",
      anchor: { path },
    });
  });

  it("says which of your notes a finding came from, and leaves out one from a note you stopped there", async () => {
    const { briefing, files } = recorded("grafana", 133736);
    const path = "public/app/features/explore/SignalExplorer/data/metricResourceClient.ts";
    const { provider, sent } = model({
      output: {
        summary: "s",
        matchesTitle: { verdict: "yes", reason: "r" },
        findings: [
          {
            title: "Missing code owner header",
            detail: "d",
            severity: "medium",
            anchors: [{ path }],
            topic: "other",
            fromNote: "N1",
          },
          { title: "Uses floats for money", detail: "d", severity: "low", anchors: [{ path }], fromNote: "N2" },
          { title: "Claims a note", detail: "d", severity: "low", anchors: [{ path }], fromNote: "N9" },
        ],
      },
    });
    const memory = (action: "add" | "exclude", item: string, extra: { text: string } | { path: string }) => ({
      schemaVersion: 1 as const,
      id: `${action}-${item}`,
      at: "2026-09-20T12:00:00.000Z",
      repo: "acme/shop",
      action,
      item,
      ...extra,
    });
    const learning = learn({
      repo: "acme/shop",
      feedback: [],
      opens: [],
      memory: [
        memory("add", "note:owners", { text: "Every file needs a code owner header" }),
        memory("add", "note:cents", { text: "Money is in cents, never floats" }),
        memory("exclude", "note:cents", { path: "public/app/features/explore/SignalExplorer/data" }),
      ] as Parameters<typeof learn>[0]["memory"],
    });
    const result = await addModelReview(briefing, {
      provider,
      config,
      ledger: new SpendLedger(join(dir, "alden.db")),
      files,
      learning,
    });
    expect(sent[0]).toContain("- [N1] Every file needs a code owner header");
    expect(sent[0]).toContain(
      "- [N2] Money is in cents, never floats (doesn't apply under public/app/features/explore/SignalExplorer/data)",
    );
    expect(result.llm?.findings.map((f) => [f.title, f.fromNote?.id])).toEqual([
      ["Missing code owner header", "note:owners"],
      ["Claims a note", undefined],
    ]);
    expect(result.needsYourEyes.find((e) => e.title === "Missing code owner header")).toMatchObject({
      fromNote: { id: "note:owners", text: "Every file needs a code owner header" },
    });
    expect(result.learning?.hidden).toContainEqual({
      title: "Uses floats for money",
      reason: "You stopped applying the note it came from to public/app/features/explore/SignalExplorer/data",
      anchor: { path },
    });
    expect(BriefingSchema.safeParse(JSON.parse(JSON.stringify(result))).error).toBeUndefined();
  });

  it("sends the effort from config, or a one-off override, and records it", async () => {
    const { briefing, files } = recorded("django", 22041);
    const seen: (string | undefined)[] = [];
    const { provider } = model({
      output: { summary: "s", matchesTitle: { verdict: "yes", reason: "r" }, findings: [] },
    });
    const spy: LlmProvider = {
      ...provider,
      generate: (request) => {
        seen.push(request.effort);
        return provider.generate(request);
      },
    };
    const withConfig = { ...config, model: { ...config.model, effort: "medium" as const } };
    const ledger = new SpendLedger(join(dir, "alden.db"));
    const fromConfig = await addModelReview(briefing, { provider: spy, config: withConfig, ledger, files });
    const overridden = await addModelReview(briefing, {
      provider: spy,
      config: withConfig,
      ledger,
      files,
      effort: "low",
    });
    const unset = await addModelReview(briefing, { provider: spy, config, ledger, files });
    expect(seen).toEqual(["medium", "low", undefined]);
    expect([fromConfig.llm?.effort, overridden.llm?.effort, unset.llm?.effort]).toEqual(["medium", "low", undefined]);
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
    ["a network error", new LlmError("network", "offline"), "failed", /reach.*\(offline\)/],
  ])("keeps the deterministic briefing after %s", async (_label, behaviour, status, note) => {
    const { briefing, files } = recorded("django", 22041);
    const result = await addModelReview(briefing, {
      provider: model(behaviour).provider,
      config,
      ledger: new SpendLedger(join(dir, "alden.db")),
      files,
    });
    expect(result.llm?.status).toBe(status);
    expect(result.llm?.note).toMatch(note);
    expect(result.needsYourEyes).toEqual(briefing.needsYourEyes);
    expect(result.checks).toEqual(briefing.checks);
  });

  it("asks again with low effort when thinking runs out the room, within what's left of the cap", async () => {
    const { briefing, files } = recorded("django", 22041);
    const calls: { effort?: string | undefined; maxOutputTokens: number }[] = [];
    const answer: LlmOutput = {
      summary: "Fixes a lookup.",
      matchesTitle: { verdict: "yes", reason: "It does." },
      findings: [],
    };
    const provider: LlmProvider = {
      provider: "anthropic",
      model: "claude-sonnet-5",
      countInputTokens: async () => 5_000,
      generate: async <T>(request: { effort?: string; maxOutputTokens: number }) => {
        calls.push({ effort: request.effort, maxOutputTokens: request.maxOutputTokens });
        const first = calls.length === 1;
        return {
          output: first ? null : answer,
          usage: { inputTokens: 5_000, outputTokens: first ? 16_000 : 1_500, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: first ? "max_tokens" : "end",
          model: "claude-sonnet-5",
        } as GenerateResult<T>;
      },
    };
    const result = await addModelReview(briefing, {
      provider,
      config,
      ledger: new SpendLedger(join(dir, "alden.db")),
      files,
    });
    expect(calls).toEqual([
      { effort: undefined, maxOutputTokens: 16_000 },
      { effort: "low", maxOutputTokens: 8_000 },
    ]);
    // Both calls are paid for: 5k in + 16k out, then 5k in + 1.5k out, at $2 and $10 a million.
    expect(result.llm).toMatchObject({ status: "ok", effort: "low", summary: "Fixes a lookup.", usd: 0.195 });
    expect(result.llm?.note).toMatch(/asked again with low effort/);
  });

  it("says when a retry wouldn't fit the cap, and doesn't retry what's already low effort", async () => {
    const { briefing, files } = recorded("django", 22041);
    const { provider, sent } = model({ stopReason: "max_tokens", output: null }, 120_000);
    const capped = { ...config, budget: { perReviewUsd: 0.5, dailyUsd: 10 } };
    const result = await addModelReview(briefing, {
      provider,
      config: capped,
      ledger: new SpendLedger(join(dir, "alden.db")),
      files,
    });
    expect(sent).toHaveLength(1);
    expect(result.llm).toMatchObject({
      status: "truncated",
      note: expect.stringMatching(/wouldn't fit your per-review cap/),
    });
    const low = await addModelReview(briefing, {
      provider,
      config,
      ledger: new SpendLedger(join(dir, "alden.db")),
      files,
      effort: "low",
    });
    expect(sent).toHaveLength(2);
    expect(low.llm?.status).toBe("truncated");
  });

  it("sends only what fits when the retry can't afford the whole PR again", async () => {
    const { briefing, files } = recorded("grafana", 133736);
    const sent: string[] = [];
    const answer: LlmOutput = {
      summary: "Searches the catalog.",
      matchesTitle: { verdict: "yes", reason: "It does." },
      findings: [],
    };
    const provider: LlmProvider = {
      provider: "anthropic",
      model: "claude-sonnet-5",
      countInputTokens: async ({ user }) => Math.ceil(user.length / 3),
      generate: async <T>(request: { user: string }) => {
        sent.push(request.user);
        const first = sent.length === 1;
        // The first answer cost $0.41 of the $0.50 cap: 125k tokens in, 16k out.
        return {
          output: first ? null : answer,
          usage: {
            inputTokens: first ? 125_000 : 2_000,
            outputTokens: first ? 16_000 : 800,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          stopReason: first ? "max_tokens" : "end",
          model: "claude-sonnet-5",
        } as GenerateResult<T>;
      },
    };
    const result = await addModelReview(briefing, {
      provider,
      config,
      ledger: new SpendLedger(join(dir, "alden.db")),
      files,
    });
    expect(sent).toHaveLength(2);
    expect((sent[1] ?? "").length).toBeLessThan((sent[0] ?? "").length);
    expect(result.llm).toMatchObject({ status: "ok", effort: "low" });
    expect(result.llm?.omittedFiles.length).toBeGreaterThan(0);
  });

  it("stops before calling when the budget can't cover the review", async () => {
    const { briefing, files } = recorded("django", 22041);
    const { provider, sent } = model({}, 400_000);
    const result = await addModelReview(briefing, {
      provider,
      config,
      ledger: new SpendLedger(join(dir, "alden.db")),
      files,
    });
    expect(result.llm).toMatchObject({ status: "over_budget", note: expect.stringMatching(/per-review cap/) });
    expect(sent).toHaveLength(0);
  });

  it("says so when today's budget is nearly gone", async () => {
    const { briefing, files } = recorded("django", 22041);
    const ledger = new SpendLedger(join(dir, "alden.db"));
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

describe("drafted comments in the model's answer", () => {
  // Line 191 is an added line: `export function fetchCatalog(…)`.
  const path = "public/app/features/explore/SignalExplorer/data/metricResourceClient.ts";

  /** A stand-in model that records the system prompt and output schema it was sent. */
  function drafting(output: LlmOutput) {
    const requests: { system: string; schema: unknown }[] = [];
    const provider: LlmProvider = {
      provider: "anthropic",
      model: "claude-sonnet-5",
      countInputTokens: async () => 10_000,
      generate: async <T>(request: { system: string; schema: unknown }) => {
        requests.push({ system: request.system, schema: request.schema });
        return {
          output,
          usage: { inputTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "end",
          model: "claude-sonnet-5",
        } as GenerateResult<T>;
      },
    };
    return { provider, requests };
  }
  const answer: LlmOutput = {
    summary: "s",
    matchesTitle: { verdict: "yes", reason: "r" },
    findings: [
      {
        title: "Callers break",
        detail: "d",
        severity: "high",
        anchors: [{ path, line: 191 }],
        topic: "api",
        draft: { body: "fetchCatalog now returns a Catalog: check the callers in SignalExplorer." },
      },
      {
        title: "Naming nit",
        detail: "d",
        severity: "low",
        anchors: [{ path, line: 191 }],
        draft: { body: "Rename this." },
      },
    ],
  };

  it("asks for drafts on a PR by default once a model is set up, and keeps the ones that check out", async () => {
    // Nothing configured: drafts.auto is on.
    expect(config.drafts.auto).toBe(true);
    const { briefing, files } = recorded("grafana", 133736);
    const { provider, requests } = drafting(answer);
    const result = await addModelReview(briefing, {
      provider,
      config,
      ledger: new SpendLedger(join(dir, "a.db")),
      files,
    });
    expect(requests[0]?.system).toBe(systemPrompt(true));
    expect(requests[0]?.system.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(requests[0]?.schema).toBe(LlmOutputWithDraftsSchema);
    expect(result.llm?.findings.map((f) => f.draft)).toEqual([
      { body: "fetchCatalog now returns a Catalog: check the callers in SignalExplorer." },
      undefined, // low severity: no draft
    ]);
    expect(result.llm?.draftsNote).toBeUndefined();
    expect(BriefingSchema.safeParse(JSON.parse(JSON.stringify(result))).error).toBeUndefined();
  });

  it("drops the draft of a finding your feedback quietened", async () => {
    const { briefing, files } = recorded("grafana", 133736);
    const { provider } = drafting({
      ...answer,
      findings: [
        {
          title: "No test for fetchCatalog",
          detail: "d",
          severity: "medium",
          anchors: [{ path, line: 191 }],
          topic: "tests",
          draft: { body: "Add a test for fetchCatalog." },
        },
      ],
    });
    const verdict = (number: number) => ({
      schemaVersion: 1 as const,
      id: `v${number}`,
      at: "2026-09-20T12:00:00.000Z",
      kind: "verdict" as const,
      target: { kind: "pr" as const, repo: "acme/shop", number },
      briefingAt: "2026-09-20T12:00:00.000Z",
      item: { source: "check" as const, checkId: "tests.missing", title: "t", placement: "eyes" as const },
      verdict: "not_needed" as const,
    });
    const learning = learn({ repo: "acme/shop", feedback: [1, 2, 3].map(verdict), opens: [], memory: [] });
    const result = await addModelReview(briefing, {
      provider,
      config,
      ledger: new SpendLedger(join(dir, "a.db")),
      files,
      learning,
    });
    expect(result.llm?.findings).toEqual([expect.not.objectContaining({ draft: expect.anything() })]);
  });

  it("asks exactly as before, and keeps no draft, when drafts.auto is off", async () => {
    const { briefing, files } = recorded("grafana", 133736);
    const { provider, requests } = drafting(answer);
    const off = AldenConfigSchema.parse({ drafts: { auto: false } });
    const result = await addModelReview(briefing, {
      provider,
      config: off,
      ledger: new SpendLedger(join(dir, "a.db")),
      files,
    });
    expect(requests[0]?.system).toBe(SYSTEM_PROMPT);
    expect(requests[0]?.schema).toBe(LlmOutputSchema);
    expect(result.llm?.findings.some((f) => f.draft)).toBe(false);
    expect(result.llm?.draftsNote).toBe(DRAFTS_OFF_NOTE);
  });

  it("asks for no drafts on local changes", async () => {
    const { briefing, files } = recorded("grafana", 133736);
    const { provider, requests } = drafting(answer);
    const local = { ...briefing, target: { kind: "local" as const, repoRoot: "/x", branch: null } };
    const result = await addModelReview(local, { provider, config, ledger: new SpendLedger(join(dir, "a.db")), files });
    expect(requests[0]?.system).toBe(SYSTEM_PROMPT);
    expect(result.llm?.draftsNote).toBeUndefined();
  });

  it("says why a PR got no drafts when none of the model's findings is one Alden drafts for", async () => {
    const { briefing, files } = recorded("grafana", 133736);
    const run = async (findings: LlmOutput["findings"]) =>
      (
        await addModelReview(briefing, {
          provider: drafting({ ...answer, findings }).provider,
          config,
          ledger: new SpendLedger(join(dir, "a.db")),
          files,
        })
      ).llm?.draftsNote;
    // A medium finding on a whole file and a low one (a check's critical place isn't the model's): nothing to draft.
    const wholeFile = { title: "Whole file", detail: "d", severity: "medium" as const, anchors: [{ path }] };
    const low = { title: "Nit", detail: "d", severity: "low" as const, anchors: [{ path, line: 191 }] };
    expect(await run([wholeFile, { ...low, draft: { body: "Rename this." } }])).toBe(NONE_TO_DRAFT_NOTE);
    expect(await run([])).toBe(NONE_TO_DRAFT_NOTE);
    // One that could have a draft, but the model wrote none.
    expect(await run([{ ...low, severity: "high" }])).toBe(NONE_DRAFTED_NOTE);
    expect(NONE_TO_DRAFT_NOTE).toBe(
      "No drafts: Alden drafts comments for the model's medium and high findings on changed lines, and this briefing had none.",
    );
  });

  it("drafts nothing for a PR with text aimed at AI reviewers, and says why", async () => {
    const { briefing, files } = recorded("grafana", 133736);
    const { provider, requests } = drafting(answer);
    const injected = {
      ...briefing,
      checks: [
        ...briefing.checks,
        {
          id: "injection.ai",
          title: "Text aimed at AI reviewers",
          status: "flagged" as const,
          severity: "high" as const,
          summary: "s",
          evidence: [],
          heuristic: true,
        },
      ],
    };
    const result = await addModelReview(injected, {
      provider,
      config,
      ledger: new SpendLedger(join(dir, "a.db")),
      files,
    });
    expect(requests[0]?.system).toBe(SYSTEM_PROMPT);
    expect(result.llm?.findings.some((f) => f.draft)).toBe(false);
    expect(result.llm?.draftsNote).toBe(INJECTED_DRAFTS_NOTE);
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

  it("keeps critical checks ahead of the model's findings too", () => {
    const merged = mergeLookHere(
      [item("migrations.changed", "db/1.sql"), item("tests.missing", "a.ts")],
      [check("migrations.changed", "critical"), check("tests.missing", "medium")],
      [finding("Race in retry", "high", ["b.ts"]), finding("Leak", "high", ["c.ts"])],
    );
    expect(merged.map((m) => m.title)).toEqual(["migrations.changed", "Race in retry", "Leak"]);
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

  it("holds as many places as review.eyes asks for", () => {
    const findings = ["a", "b", "c", "d", "e", "f"].map((f) => finding(`Bug in ${f}`, "high", [`${f}.ts`]));
    expect(mergeLookHere([], [], findings)).toHaveLength(3);
    expect(mergeLookHere([], [], findings, 5)).toHaveLength(5);
    expect(mergeLookHere([], [], findings, 10)).toHaveLength(6);
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
