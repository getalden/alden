import { z } from "zod";

/** Paths that raise a PR's risk score unless the user overrides them. */
export const DEFAULT_SENSITIVE_PATHS = [
  "**/migrations/**",
  "**/auth/**",
  "**/payments/**",
  "**/infra/**",
  ".github/workflows/**",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/composer.lock",
  "**/go.sum",
  "**/poetry.lock",
];

export const AldenConfigSchema = z.object({
  model: z
    .object({
      provider: z.enum(["anthropic", "bedrock", "vertex", "foundry", "openai-compatible"]).default("anthropic"),
      name: z.string().default("sonnet"),
      /** How hard Claude thinks: more effort, more time and tokens. Unset means the model's own default (high). */
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      /** openai-compatible: the endpoint, e.g. http://localhost:11434/v1 for Ollama. */
      baseUrl: z.url().optional(),
      /** bedrock (AWS region) and vertex (GCP region, e.g. "global"). */
      region: z.string().optional(),
      /** vertex: the GCP project ID. */
      projectId: z.string().optional(),
      /** foundry: the Azure AI Foundry resource name. */
      resource: z.string().optional(),
    })
    .prefault({}),
  budget: z
    .object({
      perReviewUsd: z.number().positive().default(0.5),
      dailyUsd: z.number().positive().default(10),
    })
    .prefault({}),
  telemetry: z
    .object({
      /**
       * Whether to send anonymous usage stats. Unset until you answer; read only from your user config, never from a
       * repo's .alden.toml. DO_NOT_TRACK, ALDEN_TELEMETRY=0 and CI turn it off regardless.
       */
      enabled: z.boolean().optional(),
    })
    .prefault({}),
  updates: z
    .object({
      /** Whether `alden --version` and `alden doctor` say when a newer Alden exists (checked at most once a day). */
      check: z.boolean().default(true),
    })
    .prefault({}),
  queue: z
    .object({
      includeDrafts: z.boolean().default(false),
      sensitivePaths: z.array(z.string()).default(DEFAULT_SENSITIVE_PATHS),
      fastTrackMaxLines: z.number().int().positive().default(50),
    })
    .prefault({}),
});

export type AldenConfig = z.infer<typeof AldenConfigSchema>;
