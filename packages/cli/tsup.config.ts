import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
  // The workspace packages are private, so bundle them into the published CLI.
  noExternal: [/^@alden\//],
  // Loaded only when configured, and installed by the user; never bundled (the AWS and Google SDKs are large).
  external: ["@anthropic-ai/bedrock-sdk", "@anthropic-ai/vertex-sdk", "@anthropic-ai/foundry-sdk"],
});
