import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { resolveModel } from "./models.js";
import {
  type GenerateRequest,
  type GenerateResult,
  LlmError,
  type LlmErrorKind,
  type LlmProvider,
  type StopReason,
} from "./provider.js";

/** Maps the SDK's typed errors to what a user can do about them. Most specific first. */
export function toLlmError(error: unknown): LlmError {
  const kind: LlmErrorKind =
    error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError
      ? "auth"
      : error instanceof Anthropic.RateLimitError
        ? "rate_limit"
        : error instanceof Anthropic.NotFoundError
          ? "not_found"
          : error instanceof Anthropic.BadRequestError
            ? "bad_request"
            : error instanceof Anthropic.APIConnectionError
              ? "network"
              : error instanceof Anthropic.APIError && (error.status === 529 || (error.status ?? 0) >= 500)
                ? "overloaded"
                : "other";
  const message = error instanceof Error ? error.message : String(error);
  return new LlmError(kind, message, error);
}

function stopReason(reason: string | null): StopReason {
  if (reason === "end_turn" || reason === "stop_sequence") return "end";
  if (reason === "max_tokens") return "max_tokens";
  if (reason === "refusal") return "refusal";
  return "other";
}

/**
 * Claude through the official SDK. Credentials resolve the SDK's usual way: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
 * or an `ant auth login` profile. Alden never uses Claude.ai subscription logins.
 */
export class AnthropicProvider implements LlmProvider {
  readonly provider = "anthropic";
  readonly model: string;

  constructor(
    model: string,
    private readonly client: Anthropic = new Anthropic(),
  ) {
    this.model = resolveModel(model);
  }

  async countInputTokens(request: { system: string; user: string }): Promise<number | undefined> {
    try {
      const counted = await this.client.messages.countTokens({
        model: this.model,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
      });
      return counted.input_tokens;
    } catch (error) {
      throw toLlmError(error);
    }
  }

  async generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
    let response: Awaited<ReturnType<typeof this.client.messages.parse>>;
    try {
      // Thinking is left to each model's default: adaptive on Sonnet 5 / Opus 5 / Fable, off on Haiku 4.5.
      response = await this.client.messages.parse({
        model: this.model,
        max_tokens: request.maxOutputTokens,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
        output_config: { format: zodOutputFormat(request.schema) },
      });
    } catch (error) {
      throw toLlmError(error);
    }

    const reason = stopReason(response.stop_reason);
    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    const result: GenerateResult<T> = {
      output: reason === "end" ? ((response.parsed_output as T | null) ?? null) : null,
      usage,
      stopReason: reason,
      model: response.model,
    };
    if (reason === "refusal") {
      const details = response.stop_details;
      result.refusal = { category: details?.category ?? null, explanation: details?.explanation ?? null };
    }
    return result;
  }
}
