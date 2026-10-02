/**
 * Checks a published release from the outside, the way a user gets it: `pnpm release:verify [version]`.
 *
 * npm has the version under `next`; the getalden/homebrew-tap release has every archive, the app and the checksums;
 * the formula and the cask point at this version; and the archive for this machine (and on a Mac, the app) downloads,
 * matches its checksum and runs. On a Mac it also checks both are signed with a Developer ID, and the app is notarized.
 * Needs `gh` signed in (for the tap) and reads nothing from your keychain: the binaries only print their version.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const version =
  process.argv[2]?.replace(/^v/, "") ??
  (JSON.parse(readFileSync(join(ROOT, "packages/cli/package.json"), "utf8")) as { version: string }).version;
const TAP = "getalden/homebrew-tap";
const UNIX = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const host = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toLowerCase().startsWith("npm_config_")));
const run = (cmd: string, args: string[], extra: Record<string, string> = {}) =>
  execFileSync(cmd, args, { env: { ...env, ...extra }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let failed = false;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  failed ||= !ok;
};
const attempt = (name: string, fn: () => void) => {
  try {
    fn();
  } catch (error) {
    check(name, false, ((error as { stderr?: string }).stderr || (error as Error).message).trim().split("\n")[0]);
  }
};

console.log(`Checking alden ${version} as published.\n`);

attempt("npm", () => {
  check("npm has the version", run("npm", ["view", `alden@${version}`, "version"]) === version);
  const next = run("npm", ["view", "alden", "dist-tags.next"]);
  check("npm `next` points at it", next === version, `next is ${next}`);
});

const work = mkdtempSync(join(tmpdir(), "alden-verify-"));
try {
  attempt("tap release", () => {
    const release = JSON.parse(
      run("gh", ["release", "view", `v${version}`, "--repo", TAP, "--json", "assets,isPrerelease"]),
    ) as {
      assets: { name: string }[];
      isPrerelease: boolean;
    };
    const names = release.assets.map((a) => a.name);
    const expected = [
      ...UNIX.map((t) => `alden-${version}-${t}.tar.gz`),
      `alden-${version}-windows-x64.zip`,
      `Alden-${version}-universal.dmg`,
      "SHA256SUMS",
    ];
    const missing = expected.filter((n) => !names.includes(n));
    check("the release has every file", missing.length === 0, missing.length ? `missing ${missing.join(", ")}` : "");
    check("the release is marked pre-release (beta)", release.isPrerelease);

    run("gh", ["release", "download", `v${version}`, "--repo", TAP, "--dir", work, "--pattern", "SHA256SUMS"]);
    const sums = new Map(
      readFileSync(join(work, "SHA256SUMS"), "utf8")
        .split("\n")
        .flatMap((l) => {
          const [sum, file] = l.trim().split(/\s+\*?/);
          return sum && file ? [[file, sum] as const] : [];
        }),
    );
    const fetch = (name: string) => {
      run("gh", ["release", "download", `v${version}`, "--repo", TAP, "--dir", work, "--pattern", name]);
      const path = join(work, name);
      const sum = createHash("sha256").update(readFileSync(path)).digest("hex");
      check(`${name} matches its checksum`, sum === sums.get(name));
      return path;
    };

    if (UNIX.includes(host)) {
      const archive = fetch(`alden-${version}-${host}.tar.gz`);
      run("tar", ["-xzf", archive, "-C", work]);
      const binary = join(work, "alden");
      const said = run(binary, ["--version"], { ALDEN_HOME: join(work, "home"), ALDEN_NO_UPDATE_CHECK: "1" });
      check(`the ${host} binary runs`, said === version, said);
      if (process.platform === "darwin") signedByDeveloperId(`the ${host} binary`, binary);
    }

    if (process.platform === "darwin") {
      const dmg = fetch(`Alden-${version}-universal.dmg`);
      const mount = join(work, "mount");
      run("hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-mountpoint", mount]);
      try {
        const app = join(mount, "Alden.app");
        const plist = run("/usr/libexec/PlistBuddy", [
          "-c",
          "Print CFBundleShortVersionString",
          `${app}/Contents/Info.plist`,
        ]);
        check("the app has the version", plist === version, plist);
        const said = run(`${app}/Contents/MacOS/alden`, ["--version"], {
          ALDEN_HOME: join(work, "home"),
          ALDEN_NO_UPDATE_CHECK: "1",
        });
        check("the app's alden runs", said === version, said);
        signedByDeveloperId("the app", app);
        attempt("the app is notarized", () => {
          const out = execFileSync("spctl", ["--assess", "--type", "execute", "-vv", app], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
          check("the app is notarized", true, out.trim());
        });
      } finally {
        run("hdiutil", ["detach", mount, "-quiet"]);
      }
    }
  });

  attempt("tap formula and cask", () => {
    const file = (path: string) =>
      Buffer.from(run("gh", ["api", `repos/${TAP}/contents/${path}`, "--jq", ".content"]), "base64").toString("utf8");
    check("Formula/alden.rb is at the version", file("Formula/alden.rb").includes(`version "${version}"`));
    check("Casks/alden-desktop.rb is at the version", file("Casks/alden-desktop.rb").includes(`version "${version}"`));
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

function signedByDeveloperId(name: string, path: string) {
  attempt(`${name} is signed`, () => {
    run("codesign", ["--verify", "--strict", path]);
    // codesign -d writes what it found to stderr.
    const details = spawnSync("codesign", ["-dvv", path], { encoding: "utf8" }).stderr;
    check(`${name} is signed with a Developer ID`, /Authority=Developer ID Application/.test(details));
    check(`${name} uses the hardened runtime`, /flags=\S*runtime/.test(details));
  });
}

console.log(failed ? "\nSomething's not right; see FAIL above." : `\nalden ${version} is published and works.`);
process.exit(failed ? 1 : 0);
