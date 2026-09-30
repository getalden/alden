import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { defineConfig } from "tsup";

const require = createRequire(import.meta.url);

/** Grammar files the code graph loads at runtime (see core/src/graph/parser.ts), shipped in dist/grammars. */
const GRAMMARS = [
  "tree-sitter-typescript/tree-sitter-typescript.wasm",
  "tree-sitter-typescript/tree-sitter-tsx.wasm",
  "tree-sitter-python/tree-sitter-python.wasm",
  "tree-sitter-go/tree-sitter-go.wasm",
  "tree-sitter-php/tree-sitter-php.wasm",
];

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
  async onSuccess() {
    mkdirSync("dist/grammars", { recursive: true });
    for (const grammar of GRAMMARS) {
      const source = require.resolve(grammar);
      cpSync(source, join("dist/grammars", grammar.split("/").at(-1) as string));
    }
    // The web UI for `alden ui`, built by @alden/ui first (it's a devDependency, so pnpm builds it before this).
    if (existsSync("../ui/dist/index.html")) cpSync("../ui/dist", "dist/ui", { recursive: true });
  },
});
