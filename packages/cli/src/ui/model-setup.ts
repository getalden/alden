import {
  ALDEN_CLOUD_URL,
  ANTHROPIC_KEYS_URL,
  detectOllama,
  isLocalModelName,
  modelSetupState,
  OLLAMA_DOWNLOAD_URL,
  ollamaUrl,
  pullOllamaModel,
  setUpModelKey,
  useLocalModel,
} from "@alden/core";
import type { KeyTestResult, LocalSetupEvent, ModelSetupState } from "@alden/schema";
import { openInBrowser } from "../commands/open.js";
import { ApiError } from "./server.js";

/** The pages the setup step links to. Only these open from the server: the desktop window can't open tabs itself. */
export const SETUP_PAGES = { keys: ANTHROPIC_KEYS_URL, cloud: ALDEN_CLOUD_URL, ollama: OLLAMA_DOWNLOAD_URL } as const;
export type SetupPage = keyof typeof SETUP_PAGES;

/** "Set up a model" from the web UI and the desktop app: the same steps as `alden setup`. */
export interface ModelSetupApi {
  state(): Promise<ModelSetupState>;
  /** Tests the key with one tiny request and stores it if it works; `untested` stores it without the request. */
  testKey(key: string, untested: boolean): Promise<KeyTestResult>;
  /** Pulls `model` with Ollama unless it's there already, then makes it the model, reporting as it goes. */
  useLocal(model: string, onEvent: (event: LocalSetupEvent) => void, signal: AbortSignal): Promise<void>;
  open(page: SetupPage): Promise<{ opened: string }>;
}

/**
 * Every review reads the config and looks up the key afresh, so what this sets up applies to the next review, in the
 * window that set it up and everywhere else, without restarting `alden ui` or the desktop app.
 */
export function createModelSetupApi(options: { cwd: string; fetch?: typeof fetch }): ModelSetupApi {
  const doFetch = options.fetch ?? fetch;
  return {
    state: () => modelSetupState({ cwd: options.cwd, fetch: doFetch }),

    testKey: (key, untested) => setUpModelKey(key, { untested }),

    async useLocal(model, onEvent, signal) {
      if (!isLocalModelName(model)) throw new ApiError(400, `"${model}" isn't a model name Ollama knows.`);
      const url = ollamaUrl();
      const ollama = await detectOllama(url, doFetch);
      if (!ollama.reachable) throw new ApiError(409, ollama.reason ?? `Ollama isn't running at ${url}.`);
      const pulled = ollama.models.some((m) => m.name === model);
      if (!pulled) {
        await pullOllamaModel(
          model,
          (p) => onEvent({ type: "progress", status: p.status, completed: p.completed, total: p.total }),
          { url, signal, fetch: doFetch },
        );
      }
      const baseUrl = await useLocalModel(model, url);
      onEvent({ type: "done", model, baseUrl });
    },

    async open(page) {
      openInBrowser(SETUP_PAGES[page], "Couldn't open a browser.");
      return { opened: SETUP_PAGES[page] };
    },
  };
}
