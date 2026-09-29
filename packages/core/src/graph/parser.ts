import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";

export type GraphLanguage = "typescript" | "tsx" | "python" | "go";

const GRAMMAR_FILES: Record<GraphLanguage, { file: string; pkg: string }> = {
  typescript: { file: "tree-sitter-typescript.wasm", pkg: "tree-sitter-typescript" },
  tsx: { file: "tree-sitter-tsx.wasm", pkg: "tree-sitter-typescript" },
  python: { file: "tree-sitter-python.wasm", pkg: "tree-sitter-python" },
  go: { file: "tree-sitter-go.wasm", pkg: "tree-sitter-go" },
};

/** Which grammar reads a file, or undefined for files the code graph doesn't cover yet. */
export function languageOf(path: string): GraphLanguage | undefined {
  if (/\.(ts|mts|cts)$/.test(path) && !path.endsWith(".d.ts")) return "typescript";
  // JSX can appear in .js files too, and the TSX grammar parses plain JavaScript.
  if (/\.(tsx|js|jsx|mjs|cjs)$/.test(path)) return "tsx";
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".go")) return "go";
  return undefined;
}

/**
 * Finds a grammar's .wasm file: next to the bundled CLI (`dist/grammars`, where the build copies them), or in the
 * grammar's npm package when running from source. `ALDEN_GRAMMARS_DIR` overrides both.
 */
export function grammarPath(language: GraphLanguage): string {
  const { file, pkg } = GRAMMAR_FILES[language];
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.ALDEN_GRAMMARS_DIR ? join(process.env.ALDEN_GRAMMARS_DIR, file) : undefined,
    join(here, "grammars", file),
  ];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  return createRequire(import.meta.url).resolve(`${pkg}/${file}`);
}

let init: Promise<void> | undefined;
const languages = new Map<GraphLanguage, Promise<Language>>();

/** A parser for one language. The runtime and each grammar load once per process. */
export async function parserFor(language: GraphLanguage): Promise<{ parser: Parser; language: Language }> {
  init ??= Parser.init();
  await init;
  let loaded = languages.get(language);
  if (!loaded) {
    loaded = Language.load(grammarPath(language));
    languages.set(language, loaded);
  }
  const lang = await loaded;
  const parser = new Parser();
  parser.setLanguage(lang);
  return { parser, language: lang };
}
