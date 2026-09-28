import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { JsonCache } from "./cache.js";

let dir: string;
let clock: number;
let cache: JsonCache;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alden-cache-"));
  clock = 1_000_000;
  cache = new JsonCache(dir, () => clock);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it("returns a value within its max age and drops it after", async () => {
  await cache.set("prs:getalden/alden", [{ number: 1 }]);
  clock += 59_000;
  expect(await cache.get("prs:getalden/alden", 60_000)).toEqual([{ number: 1 }]);
  clock += 2_000;
  expect(await cache.get("prs:getalden/alden", 60_000)).toBeUndefined();
});

it("returns undefined for keys it has never seen, and after clear", async () => {
  expect(await cache.get("missing", 60_000)).toBeUndefined();
  await cache.set("k", 1);
  await cache.clear();
  expect(await cache.get("k", 60_000)).toBeUndefined();
});
