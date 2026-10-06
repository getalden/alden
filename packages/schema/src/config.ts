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

const OWNER = /^[A-Za-z0-9-]+$/;
const REPO = /^[A-Za-z0-9-]+\/[\w.-]+$/;
const OWNER_OR_REPO = /^[A-Za-z0-9-]+(\/[\w.-]+)?$/;

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
  review: z
    .object({
      /** How many places "Needs your eyes" holds: the few a careful reviewer would look at first. */
      eyes: z.number().int().min(1).max(10).default(3),
    })
    .prefault({}),
  background: z
    .object({
      /** The desktop app briefs the top PRs waiting on you while you're away, so they're ready when you're back. */
      enabled: z.boolean().default(true),
      /**
       * Whether those briefings also ask the model, which spends within your caps. Read only from your user config,
       * never from a repo's .alden.toml, so a repo can't make you spend.
       */
      model: z.boolean().default(false),
    })
    .prefault({}),
  notifications: z
    .object({
      /** Whether the desktop app's "Briefing ready" notification plays the system's notification sound. User config only. */
      sound: z.boolean().default(true),
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
      /**
       * What your queue covers on this machine: only PRs in these organisations or users' repos, and in these repos
       * (`owner/name`); a PR in either counts. Empty means everywhere. Read from your user config only.
       */
      orgs: z.array(z.string().regex(OWNER, "an organisation or user name, e.g. getalden")).default([]),
      repos: z.array(z.string().regex(REPO, "owner/name, e.g. getalden/alden")).default([]),
      /** Organisations or repos (`owner/name`) to leave out of your queue. Read from your user config only. */
      ignore: z.array(z.string().regex(OWNER_OR_REPO, "an organisation, or owner/name for a repo")).default([]),
    })
    .prefault({}),
  clones: z
    .object({
      /**
       * Folders your clones live in, e.g. ["~/src"], searched (a few levels down) for a clone of a PR's repo so its
       * briefing can find callers from anywhere. Alden also remembers each clone it runs in. Read from your user config
       * only.
       */
      folders: z.array(z.string().min(1)).default([]),
    })
    .prefault({}),
});

export type AldenConfig = z.infer<typeof AldenConfigSchema>;
