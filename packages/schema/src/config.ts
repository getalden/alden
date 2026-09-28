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
      baseUrl: z.url().optional(),
    })
    .prefault({}),
  budget: z
    .object({
      perReviewUsd: z.number().positive().default(0.5),
      dailyUsd: z.number().positive().default(10),
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
