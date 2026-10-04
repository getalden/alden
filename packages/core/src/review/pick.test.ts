import type { CheckResult, Severity } from "@alden/schema";
import { describe, expect, it } from "vitest";
import { pickLookHere } from "./pick.js";

function flagged(id: string, severity: Severity, paths: string[], summary = `${id} summary.`): CheckResult {
  return {
    id,
    title: id,
    status: "flagged",
    severity,
    summary,
    heuristic: false,
    evidence: paths.map((path, i) => ({ text: `${id} finding ${i + 1}`, anchor: { path, line: i + 1 } })),
  };
}

describe("pickLookHere", () => {
  it("orders by severity, then by what matters most at equal severity", () => {
    const picked = pickLookHere([
      flagged("config.changed", "medium", ["config/app.php"]),
      flagged("tests.missing", "medium", ["src/a.ts"]),
      flagged("secrets.likely", "high", ["src/keys.ts"]),
    ]);
    expect(picked.map((p) => p.checkId)).toEqual(["secrets.likely", "tests.missing", "config.changed"]);
    expect(picked[0]).toEqual({
      title: "Possible secret in src/keys.ts",
      reason: "secrets.likely finding 1. secrets.likely summary.",
      anchor: { path: "src/keys.ts", line: 1 },
      checkId: "secrets.likely",
    });
  });

  it("puts critical before high", () => {
    const picked = pickLookHere([
      flagged("callers.outside", "high", ["src/cart.ts"]),
      flagged("migrations.changed", "critical", ["db/migrations/2_drop.sql"]),
    ]);
    expect(picked.map((p) => p.checkId)).toEqual(["migrations.changed", "callers.outside"]);
  });

  it("gives a file flagged by two checks only one slot", () => {
    const picked = pickLookHere([
      flagged("config.changed", "medium", [".github/workflows/ci.yml", ".github/workflows/nightly.yml"]),
      flagged("paths.sensitive", "medium", [".github/workflows/ci.yml", ".github/workflows/nightly.yml"]),
    ]);
    // ci.yml is claimed by the first check; nightly.yml shares its directory, so it doesn't take a second slot.
    expect(picked.map((p) => p.anchor?.path)).toEqual([".github/workflows/ci.yml"]);
    expect(picked[0]?.reason).toMatch(/Other files in \.github\/workflows\/ are flagged too\.$/);
  });

  it("gives a directory of similar flags one slot, but every secret its own", () => {
    const picked = pickLookHere([
      flagged("secrets.likely", "high", ["config/keys.ts", "config/more-keys.ts"]),
      flagged("config.changed", "medium", ["config/app.php", "config/queue.php", "Dockerfile"]),
    ]);
    expect(picked.map((p) => p.anchor?.path)).toEqual(["config/keys.ts", "config/app.php", "config/more-keys.ts"]);
  });

  it("fills empty slots from a single check's other files", () => {
    const picked = pickLookHere([flagged("secrets.likely", "high", ["a.ts", "b.ts", "c.ts", "d.ts"])]);
    expect(picked.map((p) => p.anchor?.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("gives a low-severity check one slot at most", () => {
    const picked = pickLookHere([
      flagged("callers.outside", "low", ["cmd/a.go", "web/b.go", "api/c.go"]),
      flagged("dependencies.changed", "low", ["go.mod"]),
    ]);
    expect(picked.map((p) => p.anchor?.path)).toEqual(["cmd/a.go", "go.mod"]);
  });

  it("gives every flagged check a slot before any check gets a second", () => {
    const picked = pickLookHere([
      flagged("secrets.likely", "high", ["a.ts", "b.ts"]),
      flagged("tests.missing", "medium", ["c.ts"]),
      flagged("config.changed", "medium", ["d.yml"]),
    ]);
    expect(picked.map((p) => p.anchor?.path)).toEqual(["a.ts", "c.ts", "d.yml"]);
  });

  it("skips lockfiles, except for secrets", () => {
    const picked = pickLookHere([
      flagged("secrets.likely", "high", ["yarn.lock"]),
      flagged("paths.sensitive", "medium", ["pnpm-lock.yaml", "app/auth/session.ts"]),
    ]);
    expect(picked.map((p) => p.anchor?.path)).toEqual(["yarn.lock", "app/auth/session.ts"]);
  });

  it("never spends a slot on failing CI, passed checks or evidence without a place", () => {
    const ci = flagged("ci.status", "high", []);
    ci.evidence = [{ text: "Status rollup: failing" }];
    const passed = { ...flagged("tests.missing", "info", ["x.ts"]), status: "passed" as const };
    expect(pickLookHere([ci, passed])).toEqual([]);
  });
});
