import { supportsEffort } from "./anthropic.js";
import { openAiSupportsEffort } from "./openai.js";

/**
 * Whether a provider's model takes Alden's effort levels: Claude models but Haiku 4.5 (on any platform), the OpenAI
 * models listed in openai.ts, and no local or other OpenAI-compatible model.
 */
export function providerSupportsEffort(provider: string, model: string): boolean {
  if (provider === "openai-compatible") return false;
  if (provider === "openai") return openAiSupportsEffort(model);
  return supportsEffort(model);
}
