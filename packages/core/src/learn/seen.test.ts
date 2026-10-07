import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AldenStore, MIGRATION_COUNT, openStore } from "../store/db.js";
import { recordSeen, SEEN_KEEP_PRS, seenPlaces } from "./seen.js";

let dir: string;
let store: AldenStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alden-seen-"));
  store = openStore(join(dir, "alden.db"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const PR = "Acme/Shop#412";
const at = (iso: string) => new Date(iso);

describe("seen places", () => {
  it("is part of the store's schema", () => {
    expect(store.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(MIGRATION_COUNT);
  });

  it("records a place once per PR, head and place, keeping the first time and how", () => {
    const place = { pr: PR, headSha: "h1", checkId: "callers.outside", path: "src/pay.ts", line: 12 } as const;
    expect(recordSeen(store, { ...place, how: "guided" }, at("2026-10-01T10:00:00Z"))).toBe(true);
    expect(recordSeen(store, { ...place, how: "diff" }, at("2026-10-01T10:05:00Z"))).toBe(false);
    expect(recordSeen(store, { pr: "acme/shop#412", headSha: "h1", path: "src/web.ts", how: "diff" })).toBe(true);
    expect(seenPlaces(store, "acme/shop#412", "h1")).toEqual([
      { checkId: "callers.outside", path: "src/pay.ts", line: 12, how: "guided" },
      { path: "src/web.ts", how: "diff" },
    ]);
  });

  it("tells places apart by check, file and line", () => {
    const base = { pr: PR, headSha: "h1", path: "src/pay.ts", how: "diff" } as const;
    recordSeen(store, { ...base, line: 12 });
    recordSeen(store, { ...base, line: 13 });
    recordSeen(store, { ...base, line: 12, checkId: "tests.missing" });
    recordSeen(store, { ...base });
    expect(seenPlaces(store, PR, "h1")).toHaveLength(4);
  });

  it("lists one head's places, or every head's with each place once", () => {
    const place = { pr: PR, path: "src/pay.ts", line: 12, how: "guided" } as const;
    recordSeen(store, { ...place, headSha: "h1" }, at("2026-10-01T10:00:00Z"));
    recordSeen(store, { ...place, headSha: "h2", how: "diff" }, at("2026-10-02T10:00:00Z"));
    recordSeen(store, { ...place, headSha: "h2", line: 40 }, at("2026-10-02T10:01:00Z"));
    expect(seenPlaces(store, PR, "h1")).toEqual([{ path: "src/pay.ts", line: 12, how: "guided" }]);
    expect(seenPlaces(store, PR, "h3")).toEqual([]);
    expect(seenPlaces(store, PR)).toEqual([
      { path: "src/pay.ts", line: 12, how: "guided" },
      { path: "src/pay.ts", line: 40, how: "guided" },
    ]);
    expect(seenPlaces(store, "acme/shop#413")).toEqual([]);
  });

  it("forgets what's older than 90 days when it records", () => {
    recordSeen(store, { pr: PR, headSha: "h1", path: "old.ts", how: "diff" }, at("2026-06-01T00:00:00Z"));
    recordSeen(store, { pr: PR, headSha: "h1", path: "new.ts", how: "diff" }, at("2026-10-01T00:00:00Z"));
    expect(seenPlaces(store, PR).map((p) => p.path)).toEqual(["new.ts"]);
  });

  it("keeps the most recently seen PRs", () => {
    const start = Date.parse("2026-10-01T00:00:00Z");
    for (let n = 0; n <= SEEN_KEEP_PRS; n++) {
      recordSeen(store, { pr: `acme/shop#${n}`, headSha: "h", path: "a.ts", how: "diff" }, new Date(start + n * 1000));
    }
    expect(seenPlaces(store, "acme/shop#0")).toEqual([]);
    expect(seenPlaces(store, "acme/shop#1")).toHaveLength(1);
    expect(seenPlaces(store, `acme/shop#${SEEN_KEEP_PRS}`)).toHaveLength(1);
  });
});
