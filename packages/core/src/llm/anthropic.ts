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
 * The part of the Messages API Alden uses. The Bedrock, Vertex and Foundry clients leave out batches, so this asks
 * only for `stream` and `countTokens`.
 */
export type MessagesClient = { messages: Pick<Anthropic["messages"], "stream" | "countTokens"> };

/**
 * Claude through the official SDKs. First-party credentials resolve the SDK's usual way (ANTHROPIC_API_KEY,
 * ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile); platforms use their own (AWS, GCP, Azure). Alden never uses
 * Claude.ai subscription logins.
 */
export class AnthropicProvider implements LlmProvider {
  readonly model: string;
  private client: Promise<MessagesClient> | undefined;

  /**
   * @param client the SDK client, or a function creating it on first use (the platform SDKs are loaded lazily).
   * @param provider the name shown in briefings and spend records, e.g. "anthropic" or "bedrock".
   */
  constructor(
    model: string,
    private readonly makeClient: MessagesClient | (() => Promise<MessagesClient>) = () =>
      Promise.resolve(new Anthropic()),
    readonly provider: string = "anthropic",
  ) {
    this.model = resolveModel(model);
  }

  private async messages(): Promise<MessagesClient["messages"]> {
    this.client ??= typeof this.makeClient === "function" ? this.makeClient() : Promise.resolve(this.makeClient);
    try {
      return (await this.client).messages;
    } catch (error) {
      this.client = undefined;
      throw error instanceof Error && error.name === "LlmError" ? error : toLlmError(error);
    }
  }

  /** Undefined when counting isn't available (some platforms), so the budget check falls back to an estimate. */
  async countInputTokens(request: { system: string; user: string }): Promise<number | undefined> {
    const messages = await this.messages();
    try {
      const counted = await messages.countTokens({
        model: this.model,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
      });
      return counted.input_tokens;
    } catch (error) {
      const failure = toLlmError(error);
      // Bad credentials will fail the real call too, with a clearer message; anything else just means "can't count".
      if (failure.kind === "auth") throw failure;
      return undefined;
    }
  }

  async generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const messages = await this.messages();
    let response: Awaited<ReturnType<ReturnType<typeof messages.stream>["finalMessage"]>>;
    try {
      // Streamed, so bytes keep flowing while the model thinks: a silent non-streaming request of a minute or more
      // gets dropped by some networks as idle ("Connection error"). The final message is parsed the same way.
      // Thinking is left to each model's default: adaptive on Sonnet 5 / Opus 5 / Fable, off on Haiku 4.5.
      response = await messages
        .stream({
          model: this.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: "user", content: request.user }],
          output_config: { format: zodOutputFormat(request.schema) },
        })
        .finalMessage();
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
