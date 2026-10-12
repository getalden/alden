import { z } from "zod";
import { resolveModel } from "./models.js";
import {
  type GenerateRequest,
  type GenerateResult,
  LlmError,
  type LlmErrorKind,
  type LlmProvider,
  type StopReason,
  type StreamTextRequest,
  type StreamTextResult,
  type TextStreamer,
} from "./provider.js";

/** Ollama's default, so `model.provider openai-compatible` works for local models with no other setup. */
export const DEFAULT_BASE_URL = "http://localhost:11434/v1";

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface ChatCompletionChunk {
  model?: string;
  choices?: { delta?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
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
export class OpenAICompatibleProvider implements LlmProvider, TextStreamer {
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

  /**
   * Plain text as it's written, from the server's server-sent events (`stream: true`), with usage when the server
   * sends it (`stream_options.include_usage`; Ollama and vLLM do). `signal` aborts the request.
   */
  async streamText(request: StreamTextRequest, onText: (delta: string) => void): Promise<StreamTextResult> {
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
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
        }),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      if (request.signal?.aborted) throw new LlmError("other", "Stopped.", error);
      throw new LlmError("network", `Couldn't reach ${url}. Is the server running?`, error);
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new LlmError(kindFor(response.status), `${url} answered ${response.status}: ${text.slice(0, 200)}`);
    }

    let text = "";
    let model = this.model;
    let finish: string | null | undefined;
    let refusal: string | undefined;
    let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const onEvent = (data: string) => {
      if (data === "[DONE]") return;
      let chunk: ChatCompletionChunk;
      try {
        chunk = JSON.parse(data) as ChatCompletionChunk;
      } catch {
        return;
      }
      if (chunk.model) model = chunk.model;
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.delta?.refusal) refusal = (refusal ?? "") + choice.delta.refusal;
      const delta = choice.delta?.content;
      if (delta) {
        text += delta;
        onText(delta);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    };
    try {
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        buffer += value ?? "";
        const lines = buffer.split(/\r?\n/);
        buffer = done ? "" : (lines.pop() ?? "");
        for (const line of lines) if (line.startsWith("data:")) onEvent(line.slice(5).trim());
        if (done) break;
      }
    } catch (error) {
      if (request.signal?.aborted) throw new LlmError("other", "Stopped.", error);
      throw new LlmError("network", `The answer from ${url} broke off.`, error);
    }
    const stopReason: StopReason =
      refusal || finish === "content_filter"
        ? "refusal"
        : finish === "length"
          ? "max_tokens"
          : finish === "stop" || finish === undefined || finish === null
            ? "end"
            : "other";
    return {
      text,
      usage,
      stopReason,
      model,
      ...(stopReason === "refusal" ? { refusal: { category: null, explanation: refusal ?? null } } : {}),
    };
  }
}
