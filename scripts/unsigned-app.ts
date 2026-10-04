/**
 * Unsigned development builds of Alden.app, which macOS registers like any app: opened by name or from Spotlight, one
 * can start instead of the installed Alden, and since it isn't signed it can't read the keychain, so it says "Sign in"
 * however you've signed in. `pnpm desktop:forget-build` unregisters and deletes the ones this checkout built;
 * `release:dry-run --desktop` does it once it has checked its app, and `desktop:build` warns about it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const TARGET = join(ROOT, "packages/desktop/src-tauri/target");
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/** Every Alden.app under the desktop package's build folder (one per target and profile). */
export function builtApps(target: string = TARGET): string[] {
  if (!existsSync(target)) return [];
  const apps: string[] = [];
  const look = (dir: string, depth: number) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name.endsWith(".app")) apps.push(path);
      else if (depth < 5 && !["deps", "build", "incremental", ".fingerprint"].includes(entry.name))
        look(path, depth + 1);
    }
  };
  look(target, 0);
  return apps;
}

/** Unregisters `app` from Launch Services (where lsregister exists) and deletes it. */
export function forgetApp(app: string): void {
  if (existsSync(LSREGISTER)) {
    try {
      execFileSync(LSREGISTER, ["-u", app], { stdio: "ignore" });
    } catch {
      // Not registered, or lsregister refused: deleting it is what matters.
    }
  }
  rmSync(app, { recursive: true, force: true });
}

export function warning(apps: string[]): string {
  return [
    "",
    `Note: this left an unsigned Alden.app at ${apps.join(", ")}.`,
    "macOS registers it, so it can open instead of the installed Alden, and unsigned it can't read the keychain (it",
    "will ask you to sign in). Run `pnpm desktop:forget-build` when you're done with it.",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const apps = builtApps();
  if (process.argv[2] === "warn") {
    if (apps.length > 0) console.warn(warning(apps));
  } else {
    for (const app of apps) forgetApp(app);
    console.log(apps.length ? `Unregistered and deleted ${apps.join(", ")}.` : "No development builds of Alden.app.");
  }
}
