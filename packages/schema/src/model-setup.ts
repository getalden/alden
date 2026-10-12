import { z } from "zod";

/**
 * Setting up a model: what's available on this machine, testing an Anthropic key, and pulling a local model. The same
 * shapes for `alden setup`, the web UI and the desktop app. Never carries a key, only where one comes from.
 */

/**
 * Where a provider's credentials come from: the environment, the key Alden stored, or (Anthropic only) the ant CLI.
 */
export const ModelKeyInfoSchema = z.object({
  source: z.enum(["env", "alden", "ant"]),
  where: z.string().describe("e.g. ANTHROPIC_API_KEY; never the key itself"),
});

/** A model Ollama has pulled. */
export const LocalModelSchema = z.object({
  name: z.string().describe("e.g. qwen2.5-coder:14b"),
  sizeBytes: z.number().int().nonnegative().nullable(),
  parameterSize: z.string().nullable().describe("as Ollama reports it, e.g. 14.8B"),
});

/** A local model Alden recommends for code review on this machine, from the table in core's llm/local.ts. */
export const LocalRecommendationSchema = z.object({
  model: z.string(),
  /** Roughly how much it downloads, e.g. "9 GB". */
  download: z.string(),
  /** Why this one, e.g. "fits 16 to 32 GB of memory". */
  why: z.string(),
  /** Already pulled: Alden can use it straight away. */
  installed: z.boolean(),
});

export const OllamaStatusSchema = z.object({
  reachable: z.boolean(),
  /** Ollama's own address (not the /v1 one Alden's provider uses), e.g. http://localhost:11434. */
  url: z.string(),
  version: z.string().nullable(),
  models: z.array(LocalModelSchema),
  /** Why it couldn't be reached, when it couldn't. */
  reason: z.string().nullable(),
});

export const ModelSetupStateSchema = z.object({
  /** What reviews use now, as the config says. */
  current: z.object({
    provider: z.string(),
    model: z.string(),
    available: z.boolean(),
    reason: z.string().nullable(),
  }),
  /** The first Anthropic credentials found, in Alden's order (environment, stored key, ant profile). */
  key: ModelKeyInfoSchema.nullable(),
  /** The first OpenAI key found: OPENAI_API_KEY, then the key Alden stored. Absent from older servers. */
  openaiKey: ModelKeyInfoSchema.nullable().optional(),
  ollama: OllamaStatusSchema,
  memoryGb: z.number(),
  recommendation: LocalRecommendationSchema,
});

/** Which provider an API key belongs to, from its shape: sk-ant-… is Anthropic's, any other sk-… OpenAI's. */
export const KeyKindSchema = z.enum(["anthropic", "openai"]);

/** The answer to testing an API key (Anthropic or OpenAI): it works (and was stored), or why not. */
export const KeyTestResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    /** Whose key it was, as Alden detected it. Absent from older servers, which took only Anthropic keys. */
    provider: KeyKindSchema.optional(),
    /** Where Alden now gets its key; an environment variable still comes first where it's set. */
    key: ModelKeyInfoSchema.nullable(),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["shape", "invalid", "permission", "billing", "network", "unavailable", "other"]),
    message: z.string(),
  }),
]);

/** One line of a streamed local setup: pull progress, then done (the config now uses it) or an error. */
export const LocalSetupEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    status: z.string().describe("Ollama's own words, e.g. 'pulling manifest'"),
    completed: z.number().nullable(),
    total: z.number().nullable(),
  }),
  z.object({ type: z.literal("done"), model: z.string(), baseUrl: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

/** The providers the model picker groups models by. Ollama is `openai-compatible` in the config. */
export const ModelGroupProviderSchema = z.enum(["anthropic", "openai", "ollama", "bedrock", "vertex", "foundry"]);

/** One model in the picker, with a word on what it's for (fast, deepest, cheap, offline). */
export const ModelChoiceSchema = z.object({
  id: z.string().describe("the model ID as the provider takes it, e.g. claude-sonnet-5, gpt-6.1-sol, qwen3-coder:30b"),
  note: z.string(),
});

export const ModelGroupSchema = z.object({
  provider: ModelGroupProviderSchema,
  label: z.string().describe("e.g. Anthropic, OpenAI, Local"),
  via: z.string().describe('how Alden reaches it: "your key", "Ollama", "AWS", "Google Cloud", "Azure"'),
  /** Set up here: a key found, Ollama running with a model pulled, or the platform configured. */
  available: z.boolean(),
  items: z.array(ModelChoiceSchema),
});

/**
 * `GET /api/models` (and the answer to `PUT /api/models`): the model reviews use now, and what can be picked. The
 * current provider is `openai-compatible` only for an endpoint that isn't Ollama (LM Studio, vLLM…).
 */
export const ModelChoicesSchema = z.object({
  current: z.object({
    provider: z.union([ModelGroupProviderSchema, z.literal("openai-compatible")]),
    model: z.string(),
  }),
  groups: z.array(ModelGroupSchema),
});

/** `PUT /api/models`: make this the model reviews use (config `model.provider` and `model.name`). */
export const ModelPickSchema = z.object({
  provider: ModelGroupProviderSchema,
  model: z.string().min(1).max(200),
});

export type KeyKind = z.infer<typeof KeyKindSchema>;
export type ModelGroupProvider = z.infer<typeof ModelGroupProviderSchema>;
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;
export type ModelGroup = z.infer<typeof ModelGroupSchema>;
export type ModelChoices = z.infer<typeof ModelChoicesSchema>;
export type ModelPick = z.infer<typeof ModelPickSchema>;
export type ModelKeyInfo = z.infer<typeof ModelKeyInfoSchema>;
export type LocalModel = z.infer<typeof LocalModelSchema>;
export type LocalRecommendation = z.infer<typeof LocalRecommendationSchema>;
export type OllamaStatus = z.infer<typeof OllamaStatusSchema>;
export type ModelSetupState = z.infer<typeof ModelSetupStateSchema>;
export type KeyTestResult = z.infer<typeof KeyTestResultSchema>;
export type LocalSetupEvent = z.infer<typeof LocalSetupEventSchema>;
