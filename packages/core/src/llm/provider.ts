import type { z } from "zod";
import type { TokenUsage } from "./models.js";

export interface GenerateRequest<T> {
  system: string;
  user: string;
  /** The output shape. Providers return it validated, or null when the model's answer didn't fit. */
  schema: z.ZodType<T>;
  maxOutputTokens: number;
  /** Thinking effort, for providers that support it; others ignore it. */
  effort?: Effort;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type StopReason = "end" | "max_tokens" | "refusal" | "other";

export interface GenerateResult<T> {
  output: T | null;
  usage: TokenUsage;
  stopReason: StopReason;
  /** Set when the model declined; the category comes from the provider, e.g. "cyber". */
  refusal?: { category: string | null; explanation: string | null };
  /** The model that actually answered. */
  model: string;
}

/** Why a call failed, in terms a user can act on. */
export type LlmErrorKind =
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "bad_request"
  | "not_found"
  | "network"
  /** Something to install or configure; the message says what. */
  | "setup"
  | "other";

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "LlmError";
  }
}

/** One model behind one provider. Alden's review code only ever talks to this. */
export interface LlmProvider {
  /** e.g. "anthropic", shown in briefings and spend records. */
  readonly provider: string;
  readonly model: string;
  /** Input tokens for a request, for pre-flight cost checks. Undefined when the provider can't count. */
  countInputTokens(request: Omit<GenerateRequest<unknown>, "schema" | "maxOutputTokens">): Promise<number | undefined>;
  generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>>;
}

/** A free-text answer, streamed: for a question about a PR, where the reader watches the words arrive. */
export interface StreamTextRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  effort?: Effort;
  /** Stops the call; what has arrived so far is kept in the result's `text`. */
  signal?: AbortSignal;
}

export interface StreamTextResult {
  text: string;
  usage: TokenUsage;
  stopReason: StopReason;
  refusal?: { category: string | null; explanation: string | null };
  model: string;
}

/** A provider that can stream plain text. The ones that can't answer in one piece through `generate`. */
export interface TextStreamer {
  streamText(request: StreamTextRequest, onText: (delta: string) => void): Promise<StreamTextResult>;
}

export const canStream = (provider: LlmProvider): provider is LlmProvider & TextStreamer =>
  typeof (provider as Partial<TextStreamer>).streamText === "function";
