/**
 * Writes the public getalden/claude-plugin repo's contents into a folder: `pnpm plugin:repo <dir>`.
 *
 * That repo is Claude Code's marketplace for Alden while this one is private: the marketplace manifest, the plugin in
 * plugins/alden, plugins/README.md as its README, and the licence. The release workflow runs this into a clone of it
 * and pushes; anything else in the folder (but .git) is removed, so the public repo always matches this one.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const out = process.argv[2];
if (!out) throw new Error("Usage: pnpm plugin:repo <dir>");
mkdirSync(out, { recursive: true });
for (const name of readdirSync(out)) if (name !== ".git") rmSync(join(out, name), { recursive: true, force: true });

cpSync(join(ROOT, ".claude-plugin"), join(out, ".claude-plugin"), { recursive: true });
cpSync(join(ROOT, "plugins/alden"), join(out, "plugins/alden"), { recursive: true });
cpSync(join(ROOT, "plugins/README.md"), join(out, "README.md"));
cpSync(join(ROOT, "LICENSE"), join(out, "LICENSE"));
if (!existsSync(join(out, "plugins/alden/.claude-plugin/plugin.json"))) throw new Error("The plugin didn't copy.");
console.log(`Wrote the claude-plugin repo into ${out}.`);
