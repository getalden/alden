import type { AldenConfig } from "@alden/schema";
import type { MessagesClient } from "./anthropic.js";
import { LlmError } from "./provider.js";

export type Platform = "bedrock" | "vertex" | "foundry";

const PACKAGES: Record<Platform, string> = {
  bedrock: "@anthropic-ai/bedrock-sdk",
  vertex: "@anthropic-ai/vertex-sdk",
  foundry: "@anthropic-ai/foundry-sdk",
};

/** Bedrock names Claude models with an "anthropic." prefix; Vertex and Foundry use the plain ID. */
export function platformModelId(platform: Platform, model: string): string {
  return platform === "bedrock" && !model.startsWith("anthropic.") ? `anthropic.${model}` : model;
}

/**
 * Loads a platform SDK only when it's configured, so a plain `npx alden` never downloads the AWS or Google SDKs.
 * A missing package becomes a "setup" error naming the install command.
 */
async function load<T>(platform: Platform, importer: () => Promise<T>): Promise<T> {
  try {
    return await importer();
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
      throw new LlmError(
        "setup",
        `Using ${platform} needs ${PACKAGES[platform]}. Install it next to Alden: npm install -g ${PACKAGES[platform]}`,
        error,
      );
    }
    throw error;
  }
}

/**
 * Creates the platform's own Anthropic client from Alden's config. Credentials come from AWS, GCP or Azure as usual;
 * a client that refuses to start (e.g. Foundry with no key) becomes a "setup" error carrying the SDK's explanation.
 */
export async function createPlatformClient(platform: Platform, model: AldenConfig["model"]): Promise<MessagesClient> {
  try {
    return await construct(platform, model);
  } catch (error) {
    if (error instanceof LlmError) throw error;
    throw new LlmError("setup", `Couldn't set up ${platform}: ${(error as Error).message}`, error);
  }
}

async function construct(platform: Platform, model: AldenConfig["model"]): Promise<MessagesClient> {
  switch (platform) {
    case "bedrock": {
      const { AnthropicBedrockMantle } = await load(platform, () => import("@anthropic-ai/bedrock-sdk"));
      return new AnthropicBedrockMantle(model.region ? { awsRegion: model.region } : {});
    }
    case "vertex": {
      const { AnthropicVertex } = await load(platform, () => import("@anthropic-ai/vertex-sdk"));
      const client = new AnthropicVertex({
        ...(model.region ? { region: model.region } : {}),
        ...(model.projectId ? { projectId: model.projectId } : {}),
      });
      // The client starts looking up Google credentials in its constructor and nothing handles a failure until the
      // first request, which can surface as an unhandled rejection. Wait for it here so it becomes a setup note.
      const pending = (client as unknown as { _authClientPromise?: Promise<unknown> })._authClientPromise;
      try {
        await pending;
      } catch (error) {
        throw new LlmError(
          "setup",
          `Couldn't find Google Cloud credentials for Vertex. Run \`gcloud auth application-default login\`, or set GOOGLE_APPLICATION_CREDENTIALS. (${(error as Error).message})`,
          error,
        );
      }
      return client;
    }
    case "foundry": {
      const { AnthropicFoundry } = await load(platform, () => import("@anthropic-ai/foundry-sdk"));
      return new AnthropicFoundry(model.resource ? { resource: model.resource } : {});
    }
  }
}
