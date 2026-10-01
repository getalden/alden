import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonCache } from "./cache.js";
import { checkForUpdate, newerVersion } from "./updates.js";

describe("newerVersion", () => {
  it.each([
    ["0.2.0", "0.1.9", true],
    ["0.10.0", "0.9.0", true],
    ["1.0.0", "1.0.0-beta.2", true],
    ["1.0.0-beta.10", "1.0.0-beta.2", true],
    ["0.1.0", "0.1.0", false],
    ["0.1.0", "0.2.0", false],
  ])("%s newer than %s: %s", (a, b, expected) => {
    expect(newerVersion(a, b)).toBe(expected);
  });
});

describe("checkForUpdate", () => {
  let dir: string;
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports the newest tag once a day, and nothing when current, offline or failing", async () => {
    dir = await mkdtemp(join(tmpdir(), "alden-update-"));
    const cache = new JsonCache(dir);
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return new Response(JSON.stringify({ latest: "0.1.0", next: "0.3.0-beta.1" }));
    }) as typeof fetch;
    expect(await checkForUpdate("0.2.0", { cache, fetcher })).toBe("0.3.0-beta.1");
    expect(await checkForUpdate("0.2.0", { cache, fetcher })).toBe("0.3.0-beta.1");
    expect(calls).toBe(1);
    expect(await checkForUpdate("0.3.0", { cache, fetcher })).toBeUndefined();
    const offline = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(await checkForUpdate("0.1.0", { cache: new JsonCache(join(dir, "x")), fetcher: offline })).toBeUndefined();
  });
});
