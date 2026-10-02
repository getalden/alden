/**
 * Puts the standalone `alden` binary where the desktop app bundles it: `pnpm desktop:sidecar [target]`.
 *
 * Tauri wants each external binary named after the Rust target it runs on (binaries/alden-aarch64-apple-darwin), so
 * this copies dist-bin/alden-<target> (from `pnpm build:binary`) under that name. The target defaults to this machine.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const RUST_TARGETS: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "windows-x64": "x86_64-pc-windows-msvc",
};

const ROOT = join(import.meta.dirname, "..");
const target = process.argv[2] ?? `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const rust = RUST_TARGETS[target];
if (!rust) throw new Error(`Unknown target ${target}. One of: ${Object.keys(RUST_TARGETS).join(", ")}`);

const exe = target.startsWith("windows") ? ".exe" : "";
const from = join(ROOT, "dist-bin", `alden-${target}${exe}`);
if (!existsSync(from)) throw new Error(`${from} is missing. Run \`pnpm build:binary\` first.`);
const dir = join(ROOT, "packages/desktop/src-tauri/binaries");
mkdirSync(dir, { recursive: true });
const to = join(dir, `alden-${rust}${exe}`);
copyFileSync(from, to);
chmodSync(to, 0o755);
console.log(`${from} → ${to}`);
