import { describe, expect, it } from "vitest";
import { withCheckoutLock } from "./checkout.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withCheckoutLock", () => {
  it("runs one piece of work at a time, in order, even when one fails", async () => {
    const log: string[] = [];
    const job = (name: string, ms: number, fail = false) =>
      withCheckoutLock(async () => {
        log.push(`start ${name}`);
        await tick(ms);
        log.push(`end ${name}`);
        if (fail) throw new Error(name);
        return name;
      });
    const results = await Promise.allSettled([job("a", 20), job("b", 5, true), job("c", 1)]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});
