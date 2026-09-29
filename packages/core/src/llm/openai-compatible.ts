import { z } from "zod";
import { resolveModel } from "./models.js";
import {
  type GenerateRequest,
  type GenerateResult,
  LlmError,
  type LlmErrorKind,
  type LlmProvider,
  type StopReason,
} from "./provider.js";

/** Ollama's default, so `model.provider openai-compatible` works for local models with no other setup. */
export const DEFAULT_BASE_URL = "http://localhost:11434/v1";

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function kindFor(status: number): LlmErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "overloaded";
  return "bad_request";
}

/**
 * Any server speaking the OpenAI chat-completions protocol: Ollama, LM Studio, vLLM, llama.cpp, OpenRouter. For local
 * and self-hosted models only; Claude always goes through Anthropic's own SDKs. Output is requested as JSON Schema and
 * validated with zod here, because not every server enforces the schema.
 */
export class OpenAICompatibleProvider implements LlmProvider {
  readonly provider = "openai-compatible";
  readonly model: string;

  constructor(
    model: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    private readonly apiKey: string | undefined = process.env.ALDEN_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
    private readonly doFetch: typeof fetch = fetch,
  ) {
    this.model = resolveModel(model);
  }

  /** These servers have no standard way to count tokens; the budget check estimates instead. */
  async countInputTokens(): Promise<undefined> {
    return undefined;
  }

  async generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    let response: Response;
    try {
      response = await this.doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: request.maxOutputTokens,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "review", schema: z.toJSONSchema(request.schema), strict: true },
          },
        }),
      });
    } catch (error) {
      throw new LlmError("network", `Couldn't reach ${url}. Is the server running?`, error);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new LlmError(kindFor(response.status), `${url} answered ${response.status}: ${text.slice(0, 200)}`);
    }

    const body = (await response.json()) as ChatCompletion;
    const choice = body.choices?.[0];
    const usage = {
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const model = body.model ?? this.model;
    const finish = choice?.finish_reason;
    const stopReason: StopReason =
      choice?.message?.refusal || finish === "content_filter"
        ? "refusal"
        : finish === "length"
          ? "max_tokens"
          : finish === "stop" || finish === undefined || finish === null
            ? "end"
            : "other";

    if (stopReason === "refusal") {
      return {
        output: null,
        usage,
        stopReason,
        model,
        refusal: { category: null, explanation: choice?.message?.refusal ?? null },
      };
    }
    let output: T | null = null;
    if (stopReason === "end" && choice?.message?.content) {
      try {
        const parsed = request.schema.safeParse(JSON.parse(choice.message.content));
        output = parsed.success ? parsed.data : null;
      } catch {
        output = null;
      }
    }
    return { output, usage, stopReason, model };
  }
}
