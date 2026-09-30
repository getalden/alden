import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getConfigValue, isKnownKey, loadConfig, setConfigValue, unsetConfigValue, userConfigPath } from "./config.js";

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

describe("loadConfig", () => {
  it("returns the defaults when no config files exist", async () => {
    const config = await loadConfig(repo);
    expect(config.model.name).toBe("sonnet");
    expect(config.budget).toEqual({ perReviewUsd: 0.5, dailyUsd: 10 });
    expect(config.queue.includeDrafts).toBe(false);
  });

  it("lets the repo config override the user config", async () => {
    await writeFile(userConfigPath(), '[model]\nname = "opus"\n[budget]\ndailyUsd = 20\n');
    await writeFile(join(repo, ".alden.toml"), '[model]\nname = "haiku"\n');
    const config = await loadConfig(repo);
    expect(config.model.name).toBe("haiku");
    expect(config.budget.dailyUsd).toBe(20);
  });
});

describe("setConfigValue", () => {
  it("writes a dotted key to the user config", async () => {
    await setConfigValue("budget.perReviewUsd", "1.25");
    expect(await readFile(userConfigPath(), "utf8")).toContain("perReviewUsd = 1.25");
    expect(getConfigValue(await loadConfig(repo), "budget.perReviewUsd")).toBe(1.25);
  });

  it("rejects values the schema refuses", async () => {
    await expect(setConfigValue("budget.dailyUsd", "-5")).rejects.toThrow(/Invalid value/);
  });

  it("rejects unknown keys", async () => {
    await expect(setConfigValue("model.colour", "blue")).rejects.toThrow(/Unknown config key/);
  });
});

describe("unsetConfigValue", () => {
  it("removes a setting so its default applies again", async () => {
    await setConfigValue("model.effort", "low");
    await setConfigValue("budget.dailyUsd", "20");
    await unsetConfigValue("model.effort");
    await unsetConfigValue("budget.dailyUsd");
    const config = await loadConfig(repo);
    expect(config.model.effort).toBeUndefined();
    expect(config.budget.dailyUsd).toBe(10);
  });

  it("does nothing for a setting that isn't there, and rejects unknown keys", async () => {
    await expect(unsetConfigValue("model.baseUrl")).resolves.toBeUndefined();
    await expect(unsetConfigValue("model.colour")).rejects.toThrow(/Unknown config key/);
  });

  it("knows optional keys that have no default", () => {
    expect(["model.effort", "model.baseUrl", "queue.sensitivePaths", "budget"].map(isKnownKey)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(["model.colour", "nope", "model.name.x"].map(isKnownKey)).toEqual([false, false, false]);
  });
});
