import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeStores } from "@alden/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { levelFromFlags, registerWatchCommand, renderWatches } from "./watch.js";

let home: string;
const saved = process.env.ALDEN_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "alden-watch-cli-"));
  process.env.ALDEN_HOME = home;
});
afterEach(() => {
  vi.restoreAllMocks();
  closeStores();
  if (saved === undefined) delete process.env.ALDEN_HOME;
  else process.env.ALDEN_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

/** Runs `alden watch …` and returns what it printed. */
async function watch(...args: string[]): Promise<string> {
  const program = new Command().exitOverride();
  registerWatchCommand(program);
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => out.push(line));
  vi.spyOn(process.stdout, "write").mockImplementation((text) => {
    out.push(String(text));
    return true;
  });
  try {
    await program.parseAsync(["node", "alden", "watch", ...args]);
  } finally {
    vi.restoreAllMocks();
  }
  return out.join("\n");
}

describe("alden watch", () => {
  it("sets a PR's level, shows it, lists it and puts it back on the global level", async () => {
    expect(await watch("acme/shop#12")).toBe(
      "acme/shop#12: your turn: a re-review, or when every comment you left is resolved or answered (the global level).",
    );
    expect(await watch("https://github.com/acme/shop/pull/12", "--every-reply")).toContain(
      "acme/shop#12: every reply: each reply, resolve, re-review and push that outdates your comment (its own level).",
    );
    expect(await watch()).toContain("acme/shop#12  every reply");
    expect(JSON.parse(await watch("--json"))).toMatchObject({
      global: "your-turn",
      prs: [{ pr: "acme/shop#12", level: "every-reply" }],
    });
    expect(JSON.parse(await watch("acme/shop#12", "--default", "--json"))).toEqual({
      pr: "acme/shop#12",
      level: "your-turn",
    });
    expect(await watch()).toContain("No PR has its own level.");
  });

  it("takes one level at a time", () => {
    expect(levelFromFlags({})).toBeUndefined();
    expect(levelFromFlags({ yourTurn: true })).toBe("your-turn");
    expect(levelFromFlags({ default: true })).toBeNull();
    expect(() => levelFromFlags({ off: true, everyReply: true })).toThrow("Pick one");
  });

  it("strips escape codes from what it lists", () => {
    const out = renderWatches(
      [{ pr: "acme/shop\u001b[31m#1", repo: "acme/shop", number: 1, level: "off", setAt: "2026-10-11T10:00:00Z" }],
      "rereview",
      false,
    );
    expect(out).toContain("Follow-ups: re-review only");
    expect(out).not.toContain("\u001b");
  });
});
