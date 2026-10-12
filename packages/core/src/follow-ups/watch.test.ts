import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AldenStore } from "../store/db.js";
import { clearWatch, levelAllows, listWatches, prWatch, setWatch, watchOverride } from "./watch.js";

let home: string;
let store: AldenStore;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "alden-watch-"));
  store = AldenStore.open(join(home, "alden.db"));
});
afterEach(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

describe("PR watch levels", () => {
  it("sets, replaces, lists and clears a PR's own level, whatever the case of its name", () => {
    expect(prWatch(store, "acme/shop", 12, "your-turn")).toEqual({ pr: "acme/shop#12", level: "your-turn" });
    setWatch(store, "Acme/Shop", 12, "off", new Date("2026-10-11T10:00:00Z"));
    setWatch(store, "acme/web", 3, "rereview", new Date("2026-10-11T11:00:00Z"));
    setWatch(store, "acme/shop", 12, "every-reply", new Date("2026-10-11T12:00:00Z"));
    expect(watchOverride(store, "ACME/shop", 12)?.level).toBe("every-reply");
    expect(prWatch(store, "acme/shop", 12, "your-turn")).toEqual({
      pr: "acme/shop#12",
      override: "every-reply",
      level: "every-reply",
    });
    expect(listWatches(store).map((w) => [w.pr, w.level])).toEqual([
      ["acme/shop#12", "every-reply"],
      ["acme/web#3", "rereview"],
    ]);
    expect(clearWatch(store, "acme/shop", 12)).toBe(true);
    expect(clearWatch(store, "acme/shop", 12)).toBe(false);
    expect(prWatch(store, "acme/shop", 12, "off")).toEqual({ pr: "acme/shop#12", level: "off" });
  });

  it("refuses a level that isn't one", () => {
    expect(() => setWatch(store, "acme/shop", 1, "loud" as never)).toThrow();
  });

  it("lets each level through what the one before it does, and more", () => {
    expect(levelAllows("off", "rereview")).toBe(false);
    expect(levelAllows("rereview", "rereview")).toBe(true);
    expect(levelAllows("rereview", "your-turn")).toBe(false);
    expect(levelAllows("your-turn", "your-turn")).toBe(true);
    expect(levelAllows("your-turn", "reply")).toBe(false);
    for (const kind of ["rereview", "your-turn", "reply", "resolved", "outdated"] as const) {
      expect(levelAllows("every-reply", kind)).toBe(true);
    }
  });
});
