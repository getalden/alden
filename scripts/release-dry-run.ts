/**
 * Rehearses a release on this machine, without publishing anything or using CI minutes: `pnpm release:dry-run`.
 *
 * It does what the Release workflow does for the host platform: builds, builds and smoke-tests the binary, packages it
 * the way the workflow does, writes checksums and the Homebrew formula (and checks it parses), then packs
 * the npm package, installs that tarball into a throwaway prefix and smoke-tests the installed `alden` under Node.
 * Everything lands in build/release/, which is what a release would upload.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "build/release");
const { version } = JSON.parse(readFileSync(join(ROOT, "packages/cli/package.json"), "utf8")) as { version: string };
const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
// pnpm passes its own npm_config_* settings down, which npm warns about; npm gets a clean environment.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toLowerCase().startsWith("npm_config_")));
const sh = (cmd: string, args: string[], cwd = ROOT) =>
  execFileSync(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
const step = (name: string) => console.log(`\n— ${name}`);
const has = (cmd: string) => {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

console.log(`Rehearsing alden ${version} for ${target}. Nothing is published.`);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

step("Desktop version");
process.stdout.write(sh("pnpm", ["-s", "tsx", "scripts/sync-desktop-version.ts", "--check"]));

step("Build");
sh("pnpm", ["build"]);
sh("pnpm", ["build:binary"]);
const binary = join(ROOT, "dist-bin", `alden-${target}${target.startsWith("windows") ? ".exe" : ""}`);

step("Smoke-test the binary");
process.stdout.write(sh("pnpm", ["-s", "smoke:binary", binary]));

step("Package, checksums and formula");
const stage = mkdtempSync(join(tmpdir(), "alden-release-"));
cpSync(binary, join(stage, "alden"));
const archive = `alden-${version}-${target}.tar.gz`;
sh("tar", ["-czf", join(OUT, archive), "-C", stage, "alden"]);
rmSync(stage, { recursive: true, force: true });
const sum = sh("shasum", ["-a", "256", archive], OUT);
// The formula needs all four Unix archives. The others are built on their own runners, so stand in for them here.
const others = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]
  .filter((t) => t !== target)
  .map((t) => `${"0".repeat(64)}  alden-${version}-${t}.tar.gz\n`);
writeFileSync(join(OUT, "SHA256SUMS"), sum + others.join(""));
writeFileSync(join(OUT, "alden.rb"), sh("pnpm", ["-s", "homebrew:formula", version, join(OUT, "SHA256SUMS")]));
console.log(`${archive} ${sum.split(" ")[0]}`);
// `brew style` only lints formulae inside a tap, so check the Ruby parses; the tap's own CI does the rest.
if (has("ruby")) {
  sh("ruby", ["-c", join(OUT, "alden.rb")]);
  console.log("alden.rb parses");
} else console.log("ruby isn't installed, so the formula wasn't checked");

step("npm package");
const packed = JSON.parse(sh("npm", ["pack", "--json", "--pack-destination", OUT], join(ROOT, "packages/cli"))) as {
  filename: string;
  files: { path: string }[];
}[];
const tarball = packed[0];
if (!tarball) throw new Error("npm pack produced nothing.");
const paths = tarball.files.map((f) => f.path);
for (const needed of ["package.json", "README.md", "LICENSE", "dist/index.js"]) {
  if (!paths.includes(needed)) throw new Error(`The npm package is missing ${needed}.`);
}
const manifest = JSON.parse(readFileSync(join(ROOT, "packages/cli/package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};
const workspace = Object.entries(manifest.dependencies).filter(([, range]) => range.startsWith("workspace:"));
if (workspace.length) throw new Error(`Runtime dependencies on workspace packages: ${workspace.map(([n]) => n)}.`);
console.log(`${tarball.filename}: ${paths.length} files`);

step("Install the npm package and smoke-test it");
const prefix = mkdtempSync(join(tmpdir(), "alden-npm-"));
try {
  sh("npm", ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", join(OUT, tarball.filename)]);
  process.stdout.write(sh("pnpm", ["-s", "smoke:binary", join(prefix, "bin/alden")]));
} finally {
  rmSync(prefix, { recursive: true, force: true });
}

console.log(`\nReady: ${readdirSync(OUT).join(", ")} in build/release/.`);
