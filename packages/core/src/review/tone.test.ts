import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AldenConfigSchema, type Briefing, DRAFT_TONES, type DraftTone } from "@alden/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromRestFile } from "../diff/sources.js";
import { SpendLedger } from "../llm/ledger.js";
import type { GenerateRequest, GenerateResult, LlmProvider } from "../llm/provider.js";
import { AldenStore } from "../store/db.js";
import {
  draftReview,
  draftReviewPrompt,
  draftReviewSystem,
  suggestCommentText,
  suggestTextPrompt,
  suggestTextSystem,
  UNTRUSTED,
} from "./draft-review.js";
import { buildPrompt, DRAFTS_PROMPT, draftsPrompt, SYSTEM_PROMPT, systemPrompt } from "./llm/prompt.js";
import { addModelReview } from "./llm/run.js";
import { repoTone, setRepoTone, TONE_INSTRUCTIONS, toneFor, toneInstruction } from "./tone.js";

const PATH = "src/pay.ts";
const PATCH = ["@@ -0,0 +1,20 @@", ...Array.from({ length: 20 }, (_, i) => `+const v${i + 1} = ${i + 1};`)].join("\n");
const FILES = [fromRestFile({ filename: PATH, status: "added", additions: 20, deletions: 0, patch: PATCH })];
const config = AldenConfigSchema.parse({});
const TARGET = {
  kind: "pr",
  repo: "acme/shop",
  number: 7,
  url: "https://github.com/acme/shop/pull/7",
  title: "Charge in cents",
  author: "ana",
  baseRef: "main",
  headRef: "cents",
  headSha: "h1",
} as const;
const briefing = {
  schemaVersion: 1,
  target: TARGET,
  generatedAt: "2026-10-01T00:00:00.000Z",
  summary: { files: 1, additions: 20, deletions: 0, reviewableAdditions: 20, reviewableDeletions: 0 },
  checks: [],
  needsYourEyes: [
    { title: "Fee in dollars", reason: "r", source: "check", checkId: "x.y", anchor: { path: PATH, line: 4 } },
  ],
  files: [],
  notChecked: [],
  llm: { status: "ok", findings: [], droppedFindings: 0, omittedFiles: [] },
} as unknown as Briefing;

let home: string;
let store: AldenStore;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "alden-tone-"));
  store = AldenStore.open(join(home, "alden.db"));
});
afterEach(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

/** A fake model recording each request's system prompt and answering `output`. */
function model(output: unknown) {
  const systems: string[] = [];
  const provider: LlmProvider = {
    provider: "anthropic",
    model: "claude-sonnet-5",
    countInputTokens: async () => 1_000,
    generate: async <T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> => {
      systems.push(request.system);
      return {
        output: output as T,
        usage: { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end",
        model: "claude-sonnet-5",
      };
    },
  };
  return { provider, systems };
}

describe("a repo's tone", () => {
  it("follows drafts.tone until the repo has its own, kept per repo whatever its case", () => {
    expect(toneFor("acme/shop", config, store)).toEqual({ tone: "concise", source: "default" });
    const detailed = AldenConfigSchema.parse({ drafts: { tone: "detailed" } });
    expect(toneFor("acme/shop", detailed, store)).toEqual({ tone: "detailed", source: "default" });

    setRepoTone("Acme/Shop", "terse", store);
    expect(repoTone("acme/shop", store)).toBe("terse");
    expect(toneFor("acme/shop", detailed, store)).toEqual({ tone: "terse", source: "repo" });
    expect(toneFor("acme/other", detailed, store)).toEqual({ tone: "detailed", source: "default" });
    expect(toneFor(undefined, detailed, store)).toEqual({ tone: "detailed", source: "default" });

    setRepoTone("acme/shop", "teaching", store);
    expect(toneFor("acme/shop", config, store)).toEqual({ tone: "teaching", source: "repo" });
    setRepoTone("acme/shop", null, store);
    expect(toneFor("acme/shop", config, store)).toEqual({ tone: "concise", source: "default" });
  });

  it("ignores a value that isn't a tone, and the global one stands when the database can't be read", () => {
    store.run("INSERT INTO meta (key, value) VALUES (?, ?)", "drafts.tone:acme/shop", "shouty");
    expect(repoTone("acme/shop", store)).toBeUndefined();
    store.close();
    expect(toneFor("acme/shop", config, store)).toEqual({ tone: "concise", source: "default" });
    store = AldenStore.open(join(home, "alden.db"));
  });

  it("rejects an unknown drafts.tone in config", () => {
    expect(AldenConfigSchema.safeParse({ drafts: { tone: "rude" } }).success).toBe(false);
  });
});

describe("the tone in each drafting prompt", () => {
  it("gives each tone its own instruction", () => {
    expect(new Set(Object.values(TONE_INSTRUCTIONS)).size).toBe(4);
    expect(toneInstruction("terse")).toMatch(/one short line/);
    expect(toneInstruction("terse")).toMatch(/No reasoning/);
    expect(toneInstruction("concise")).toMatch(/one to three plain sentences/);
    expect(toneInstruction("detailed")).toMatch(/why it matters \(the impact/);
    expect(toneInstruction("detailed")).toMatch(/concrete fix/);
    expect(toneInstruction("teaching")).toMatch(/newer to this code/);
    expect(toneInstruction()).toBe(TONE_INSTRUCTIONS.concise);
  });

  it.each(DRAFT_TONES)(
    "puts the %s instruction in Draft my review and Draft with Alden, keeping every rule",
    (tone) => {
      const others = DRAFT_TONES.filter((t) => t !== tone);
      const review = draftReviewPrompt({
        briefing,
        places: [
          { id: "P1", title: "t", reason: "r", source: "check", severity: "medium", anchor: { path: PATH, line: 4 } },
        ],
        files: FILES,
        tone,
      });
      const suggest = suggestTextPrompt({ target: TARGET, files: FILES, for: { at: { path: PATH, line: 4 } }, tone });
      for (const system of [review.system, suggest.system]) {
        expect(system).toContain(TONE_INSTRUCTIONS[tone]);
        for (const other of others) expect(system).not.toContain(TONE_INSTRUCTIONS[other]);
        // The rules stay whatever the tone: PR text is data, never approve, never mention being an AI.
        expect(system).toContain(UNTRUSTED);
        expect(system).toMatch(/never approve the change/);
        expect(system).toMatch(/Never mention being an AI/);
      }
      expect(review.system).toBe(draftReviewSystem(tone));
      expect(suggest.system).toBe(suggestTextSystem(tone));
      // The PR stays fenced.
      expect(review.user).toContain("<pr-content>");
      expect(suggest.user).toContain("<pr-content>");
    },
  );

  it.each(DRAFT_TONES)("asks for the briefing's drafts in the %s tone", (tone) => {
    const built = buildPrompt({
      target: TARGET,
      files: FILES,
      checks: [],
      maxInputTokens: 100_000,
      drafts: true,
      tone,
    });
    expect(built.system).toBe(systemPrompt(true, tone));
    expect(built.system.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(built.system).toContain(draftsPrompt(tone));
    expect(built.system).toMatch(/never mention being an AI/);
    if (tone === "concise") {
      // Concise is the wording drafts always had, so a concise review keeps its prompt cache.
      expect(built.system).toBe(`${SYSTEM_PROMPT}\n\n${DRAFTS_PROMPT}`);
      expect(DRAFTS_PROMPT).toContain("one to three plain sentences");
    } else {
      expect(built.system).toContain(TONE_INSTRUCTIONS[tone]);
      expect(built.system).not.toContain("one to three plain sentences");
    }
    // No drafts, no tone: the system prompt is the plain one whatever the tone.
    expect(buildPrompt({ target: TARGET, files: FILES, checks: [], maxInputTokens: 100_000, tone }).system).toBe(
      SYSTEM_PROMPT,
    );
  });
});

describe("the tone reaching the model", () => {
  it.each(DRAFT_TONES)("sends Draft my review in the %s tone", async (tone: DraftTone) => {
    const { provider, systems } = model({ drafts: [] });
    await draftReview({
      briefing,
      files: FILES,
      headSha: "h1",
      provider,
      config,
      ledger: new SpendLedger(store),
      store,
      tone,
    });
    expect(systems).toEqual([draftReviewSystem(tone)]);
  });

  it.each(DRAFT_TONES)("sends Draft with Alden in the %s tone", async (tone: DraftTone) => {
    const { provider, systems } = model({ text: "Is `v4` in cents?" });
    await suggestCommentText({
      target: TARGET,
      files: FILES,
      for: { at: { path: PATH, line: 4 } },
      provider,
      config,
      ledger: new SpendLedger(store),
      tone,
    });
    expect(systems).toEqual([suggestTextSystem(tone)]);
  });

  it("writes in concise when no tone is given", async () => {
    const { provider, systems } = model({ text: "Is `v4` in cents?" });
    await suggestCommentText({
      target: TARGET,
      files: FILES,
      for: {},
      provider,
      config,
      ledger: new SpendLedger(store),
    });
    expect(systems[0]).toContain(TONE_INSTRUCTIONS.concise);
  });

  it("asks a briefing's drafts in the tone given, else drafts.tone", async () => {
    const answer = { summary: "s", matchesTitle: { verdict: "yes", reason: "r" }, findings: [] };
    const teaching = model(answer);
    const base = { ...briefing, files: [], needsYourEyes: [], llm: undefined } as unknown as Briefing;
    await addModelReview(base, {
      provider: teaching.provider,
      config,
      ledger: new SpendLedger(store),
      files: FILES,
      tone: "teaching",
    });
    expect(teaching.systems[0]).toBe(systemPrompt(true, "teaching"));

    const terse = model(answer);
    await addModelReview(base, {
      provider: terse.provider,
      config: AldenConfigSchema.parse({ drafts: { tone: "terse" } }),
      ledger: new SpendLedger(store),
      files: FILES,
    });
    expect(terse.systems[0]).toBe(systemPrompt(true, "terse"));
  });
});
