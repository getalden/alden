/**
 * Builds packages/core/grammars/tree-sitter-swift.wasm, which the code graph loads for Swift. tree-sitter-swift ships
 * no .wasm, unlike the other grammars, so the file is built once and checked in. Run it again only to move to a newer
 * grammar: bump the versions below, run `pnpm tsx scripts/build-swift-grammar.ts`, and commit the new file.
 * tree-sitter's CLI downloads the WASI SDK it compiles with on first use.
 *
 * The npm package lags the grammar (0.7.1 there misparses about half of a real Swift codebase and parses ten times
 * slower), so this builds the tag that carries the generated parser. Its scanner logs to stderr when out of memory,
 * which wasm built without libc stdio can't link, so that one line is dropped.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "https://github.com/alex-pinkus/tree-sitter-swift";
const TAG = "0.7.4-with-generated-files";
// Keep in step with web-tree-sitter in packages/core, which loads what this CLI builds.
const CLI = "tree-sitter-cli@0.27.1";

const root = join(import.meta.dirname, "..");
const out = join(root, "packages/core/grammars/tree-sitter-swift.wasm");
const work = mkdtempSync(join(tmpdir(), "alden-swift-grammar-"));
try {
  const run = (cmd: string, args: string[], cwd = work) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
  run("git", ["clone", "--quiet", "--depth", "1", "--branch", TAG, REPO, "grammar"]);
  const scanner = join(work, "grammar/src/scanner.c");
  writeFileSync(scanner, readFileSync(scanner, "utf8").replace(/fprintf\(stderr,[^;]*\);/g, "/* out of memory */"));
  run("npx", ["--yes", CLI, "build", "--wasm", "-o", out, "."], join(work, "grammar"));
  console.log(`Built ${out}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
