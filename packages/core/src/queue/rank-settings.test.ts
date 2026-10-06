import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, setConfigValue, setRankSettings, userConfigPath } from "../config.js";

// `[queue.rank]` in your user config. Here rather than in config.test.ts: rules carry a `then` key, which lint allows
// only in the ranking's own files.

let home: string;
let repo: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "alden-home-"));
  repo = await mkdtemp(join(tmpdir(), "alden-repo-"));
  process.env.ALDEN_HOME = home;
});

afterEach(async () => {
  delete process.env.ALDEN_HOME;
  await rm(home, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

describe("setRankSettings", () => {
  it("writes weights and rules as [queue.rank], keeping only what differs from the defaults", async () => {
    await setConfigValue("queue.orgs", "acme");
    await setRankSettings({
      weights: { waiting: 2, size: 0, risk: 1 },
      rules: [
        { when: { path: "payments/" }, then: "first" },
        { when: { author: "bots" }, then: "lower", by: 3 },
      ],
      prepare: 5,
    });
    const text = await readFile(userConfigPath(), "utf8");
    expect(text).toContain("[[queue.rank.rules]]");
    expect(text).not.toContain("risk");
    const config = await loadConfig(repo);
    expect(config.queue.orgs).toEqual(["acme"]);
    expect(config.queue.rank).toMatchObject({ waiting: 2, size: 0, risk: 1, urgentLabel: 1 });
    expect(config.queue.rank.rules).toEqual([
      { when: { path: "payments/" }, then: "first" },
      { when: { author: "bots" }, then: "lower", by: 3 },
    ]);
    expect(config.background.prepare).toBe(5);

    await setRankSettings({ weights: { waiting: null, size: 1 }, rules: [], prepare: null });
    const reset = await loadConfig(repo);
    expect(reset.queue.rank.waiting).toBe(1);
    expect(reset.queue.rank.rules).toEqual([]);
    expect(reset.background.prepare).toBe(3);
    expect(await readFile(userConfigPath(), "utf8")).not.toContain("rank");
  });

  it("rejects what the schema refuses, and leaves the file as it was", async () => {
    await setRankSettings({ weights: { waiting: 2 } });
    await expect(setRankSettings({ weights: { waiting: 20 } })).rejects.toThrow(/queue.rank.waiting/);
    await expect(setRankSettings({ rules: [{ when: {}, then: "first" }] as never })).rejects.toThrow(
      /at least one condition/,
    );
    await expect(setRankSettings({ prepare: 11 })).rejects.toThrow(/background.prepare/);
    await expect(setRankSettings({ weights: { speed: 2 } as never })).rejects.toThrow(/Unknown ranking weight/);
    expect((await loadConfig(repo)).queue.rank.waiting).toBe(2);
  });

  it("is yours: a repo's .alden.toml can't change how you rank", async () => {
    await setRankSettings({ weights: { waiting: 2 } });
    await writeFile(join(repo, ".alden.toml"), "[queue.rank]\nwaiting = 0\nsize = 3\n");
    const config = await loadConfig(repo);
    expect(config.queue.rank.waiting).toBe(2);
    expect(config.queue.rank.size).toBe(1);
  });

  it("takes a weight from alden config set, like any setting", async () => {
    await setConfigValue("queue.rank.urgentLabel", "1.5");
    expect((await loadConfig(repo)).queue.rank.urgentLabel).toBe(1.5);
    await setConfigValue("background.prepare", "0");
    expect((await loadConfig(repo)).background.prepare).toBe(0);
  });
});
