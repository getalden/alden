/**
 * Gives the desktop app the CLI's version, so the app and the `alden` inside it always match:
 * `pnpm release:version` runs it after `changeset version`. Pass `--check` to fail instead of writing (CI does).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const { version } = JSON.parse(readFileSync(join(ROOT, "packages/cli/package.json"), "utf8")) as { version: string };

const files: [string, RegExp, string][] = [
  ["packages/desktop/package.json", /^( {2}"version": )"[^"]+"/m, `$1"${version}"`],
  ["packages/desktop/src-tauri/tauri.conf.json", /^( {2}"version": )"[^"]+"/m, `$1"${version}"`],
  ["packages/desktop/src-tauri/Cargo.toml", /^(version = )"[^"]+"/m, `$1"${version}"`],
  ["packages/desktop/src-tauri/Cargo.lock", /^(name = "alden-desktop"\nversion = )"[^"]+"/m, `$1"${version}"`],
];
let stale = 0;
for (const [file, pattern, replacement] of files) {
  const path = join(ROOT, file);
  const before = readFileSync(path, "utf8");
  if (!pattern.test(before)) throw new Error(`No version in ${file}.`);
  const after = before.replace(pattern, replacement);
  if (after === before) continue;
  stale++;
  if (check) console.error(`${file} doesn't have version ${version}.`);
  else writeFileSync(path, after);
}
if (check && stale) process.exit(1);
console.log(check ? `The desktop app is at ${version}.` : `The desktop app is now at ${version}.`);
