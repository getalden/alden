import type { LocalModel, LocalRecommendation, OllamaStatus } from "@alden/schema";
import { setConfigValue, unsetConfigValue } from "../config.js";
import { DEFAULT_BASE_URL } from "./openai-compatible.js";

/** Where Ollama listens unless OLLAMA_HOST says otherwise. Its OpenAI-compatible API is under /v1. */
export const OLLAMA_URL = "http://localhost:11434";

/**
 * The local models Alden suggests for code review, by how much memory the machine has (os.totalmem). Coder models,
 * because they follow the JSON schema a briefing needs and read diffs well; each tier leaves room for the editor and
 * browser you have open. Kept here only: `alden setup`, the web UI and docs/models.md all show this table.
 */
export const LOCAL_MODEL_TABLE: readonly { underGb: number; model: string; download: string; why: string }[] = [
  { underGb: 16, model: "qwen2.5-coder:7b", download: "4.7 GB", why: "fits under 16 GB of memory" },
  { underGb: 32, model: "qwen2.5-coder:14b", download: "9 GB", why: "fits 16 to 32 GB of memory" },
  {
    underGb: Number.POSITIVE_INFINITY,
    model: "qwen3-coder:30b",
    download: "19 GB",
    why: "for 32 GB of memory or more",
  },
];

/** Whether Ollama's name for a pulled model is `model`, or a variant of it such as qwen2.5-coder:7b-instruct-q8_0. */
function isModel(name: string, model: string): boolean {
  return name === model || name.startsWith(`${model}-`);
}

/**
 * The model to use on a machine with `memoryGb` of memory: the table's model for it if it's pulled, else a smaller one
 * from the table that's already pulled (no download), else the table's model, to pull.
 */
export function recommendLocalModel(memoryGb: number, installed: readonly LocalModel[]): LocalRecommendation {
  const tier = Math.max(
    0,
    LOCAL_MODEL_TABLE.findIndex((row) => memoryGb < row.underGb),
  );
  for (let i = tier; i >= 0; i--) {
    const row = LOCAL_MODEL_TABLE[i];
    if (!row) continue;
    const found = installed.find((m) => isModel(m.name, row.model));
    if (found) {
      return {
        model: found.name,
        download: row.download,
        why: i === tier ? row.why : "already pulled, and fits your memory",
        installed: true,
      };
    }
  }
  const row = LOCAL_MODEL_TABLE[tier] ?? LOCAL_MODEL_TABLE[0];
  return {
    model: row?.model ?? "qwen2.5-coder:7b",
    download: row?.download ?? "",
    why: row?.why ?? "",
    installed: false,
  };
}

/**
 * Ollama's address: OLLAMA_HOST when it's set (as Ollama reads it: "0.0.0.0", "127.0.0.1:11500", "http://box:11434"),
 * else the default. A listen-on-everything address becomes localhost, which is where to reach it from here.
 */
export function ollamaUrl(env: NodeJS.ProcessEnv = process.env): string {
  let host = env.OLLAMA_HOST?.trim();
  if (!host) return OLLAMA_URL;
  if (host.startsWith(":")) host = `localhost${host}`;
  const withScheme = /^https?:\/\//i.test(host) ? host : `http://${host}`;
  try {
    const url = new URL(withScheme);
    if (url.hostname === "0.0.0.0" || url.hostname === "[::]") url.hostname = "localhost";
    // No port given: Ollama's own, except over https where the default port is meant.
    if (!/^https?:\/\/[^/]*:\d+/i.test(withScheme) && url.protocol === "http:") url.port = "11434";
    return url.origin;
  } catch {
    return OLLAMA_URL;
  }
}

interface Tags {
  models?: { name?: string; model?: string; size?: number; details?: { parameter_size?: string } }[];
}

/** Whether Ollama answers at `url`, its version, and the models it has pulled. Never throws. */
export async function detectOllama(
  url: string = ollamaUrl(),
  doFetch: typeof fetch = fetch,
  timeoutMs = 1_500,
): Promise<OllamaStatus> {
  const get = (path: string) => doFetch(`${url}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  try {
    const tags = await get("/api/tags");
    if (!tags.ok) {
      return { reachable: false, url, version: null, models: [], reason: `${url} answered ${tags.status}.` };
    }
    const body = (await tags.json()) as Tags;
    const models: LocalModel[] = (body.models ?? []).flatMap((m) => {
      const name = m.name ?? m.model;
      if (!name) return [];
      return [
        {
          name,
          sizeBytes: typeof m.size === "number" ? m.size : null,
          parameterSize: m.details?.parameter_size ?? null,
        },
      ];
    });
    const version = await get("/api/version")
      .then((r) => (r.ok ? (r.json() as Promise<{ version?: string }>) : undefined))
      .then((v) => v?.version ?? null)
      .catch(() => null);
    return { reachable: true, url, version, models, reason: null };
  } catch {
    return {
      reachable: false,
      url,
      version: null,
      models: [],
      reason: `Ollama isn't running at ${url}, or isn't installed.`,
    };
  }
}

/** A step of `ollama pull`, as Ollama streams it. */
export interface PullProgress {
  status: string;
  completed: number | null;
  total: number | null;
}

/** Model names Ollama takes: `name`, `name:tag`, `namespace/name:tag`. Nothing that could reach another endpoint. */
export function isLocalModelName(name: string): boolean {
  return /^[\w][\w.-]*(\/[\w][\w.-]*)?(:[\w][\w.-]*)?$/.test(name) && name.length <= 200;
}

/**
 * Pulls `model` with Ollama's /api/pull, calling `onProgress` as it streams (pulling the manifest, then each layer's
 * bytes, verifying, success). Resolves once Ollama says success; throws with Ollama's own error otherwise.
 */
export async function pullOllamaModel(
  model: string,
  onProgress: (progress: PullProgress) => void,
  options: { url?: string; fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<void> {
  if (!isLocalModelName(model)) throw new Error(`"${model}" isn't a model name Ollama knows how to pull.`);
  const url = options.url ?? ollamaUrl();
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${url}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted) throw new Error("Stopped the download.");
    throw new Error(`Couldn't reach Ollama at ${url}. Is it running?`, { cause: error });
  }
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(`Ollama couldn't pull ${model} (${response.status}): ${errorOf(text) ?? text.slice(0, 200)}`);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += value ?? "";
    const lines = buffer.split("\n");
    buffer = done ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: { status?: string; error?: string; completed?: number; total?: number };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.error) throw new Error(`Ollama couldn't pull ${model}: ${event.error}`);
      const status = event.status ?? "";
      onProgress({ status, completed: event.completed ?? null, total: event.total ?? null });
      if (status === "success") return;
    }
    if (done) throw new Error(`Ollama stopped before ${model} finished downloading. Try again.`);
  }
}

function errorOf(text: string): string | undefined {
  try {
    return (JSON.parse(text) as { error?: string }).error;
  } catch {
    return undefined;
  }
}

/**
 * Points Alden's openai-compatible provider at `model` on Ollama, in your user config: model.provider, model.name, and
 * model.baseUrl only when Ollama isn't at its default address (so the desktop app, which never sees OLLAMA_HOST,
 * finds it too). Returns the base URL the provider uses.
 */
export async function useLocalModel(model: string, url: string = ollamaUrl()): Promise<string> {
  const baseUrl = `${url.replace(/\/+$/, "")}/v1`;
  await setConfigValue("model.provider", "openai-compatible");
  await setConfigValue("model.name", model);
  if (baseUrl === DEFAULT_BASE_URL) await unsetConfigValue("model.baseUrl");
  else await setConfigValue("model.baseUrl", baseUrl);
  return baseUrl;
}
