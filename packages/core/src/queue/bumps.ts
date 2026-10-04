import type { MajorBump } from "@alden/schema";
import { breakingPart, isManifest, parseManifest } from "../review/dependencies.js";

export type { MajorBump };

/** Go puts a module's major version in its path (`/v2`, or `.v2` on gopkg.in), so 1 → 2 changes the name. */
function goModule(name: string, version: string): { name: string; version: string } {
  const suffix = /^(.*?)[/.]v(\d+)$/.exec(name);
  return suffix?.[1] && suffix[2] ? { name: suffix[1], version: `v${suffix[2]}` } : { name, version };
}

const compare = (a: string, b: string) => {
  const [aMajor = 0, aMinor = 0] = a.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = b.split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor;
};

/**
 * Dependencies a manifest change moves up a major version (or a 0.x minor one, which semver treats as breaking).
 * Only upgrades count: `before` is the base branch's tip, so a PR branch that's behind it can look like a downgrade.
 */
export function majorBumps(path: string, before: string | undefined, after: string | undefined): MajorBump[] {
  if (before === undefined || after === undefined || !isManifest(path)) return [];
  const go = path.split("/").at(-1) === "go.mod";
  const parts = (text: string) => {
    const map = new Map<string, string>();
    for (const dep of parseManifest(path, text).values()) {
      const { name, version } = go ? goModule(dep.name, dep.version) : dep;
      const part = breakingPart(version);
      // A package listed in more than one group counts once, at its lowest version.
      const seen = map.get(name);
      if (part !== undefined && (seen === undefined || compare(part, seen) < 0)) map.set(name, part);
    }
    return map;
  };
  try {
    const from = parts(before);
    const bumps: MajorBump[] = [];
    for (const [name, to] of parts(after)) {
      const was = from.get(name);
      if (was !== undefined && compare(to, was) > 0) bumps.push({ name, from: was, to });
    }
    return bumps;
  } catch {
    // A manifest that doesn't parse on either side says nothing about bumps.
    return [];
  }
}
