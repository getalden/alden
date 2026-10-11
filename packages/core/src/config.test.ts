import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getConfigValue,
  isKnownKey,
  loadConfig,
  queueScope,
  setConfigValue,
  unsetConfigValue,
  userConfigPath,
} from "./config.js";

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

describe("notification sound", () => {
  it("is on by default, and only your user config turns it off", async () => {
    expect((await loadConfig(repo)).notifications.sound).toBe(true);
    await writeFile(join(repo, ".alden.toml"), "[notifications]\nsound = false\n");
    expect((await loadConfig(repo)).notifications.sound).toBe(true);
    await setConfigValue("notifications.sound", "false");
    expect((await loadConfig(repo)).notifications.sound).toBe(false);
  });
});

describe("follow-up notifications", () => {
  it("tell you when it's your turn by default, and only your user config changes that", async () => {
    expect((await loadConfig(repo)).notifications.followUps).toBe("your-turn");
    await writeFile(join(repo, ".alden.toml"), '[notifications]\nfollowUps = "every-reply"\n');
    expect((await loadConfig(repo)).notifications.followUps).toBe("your-turn");
    await setConfigValue("notifications.followUps", "off");
    expect((await loadConfig(repo)).notifications.followUps).toBe("off");
    await expect(setConfigValue("notifications.followUps", "loud")).rejects.toThrow();
  });
});

describe("learning from reviews", () => {
  it("is on by default, and only your user config turns it off", async () => {
    expect((await loadConfig(repo)).learning.fromReviews).toBe(true);
    await writeFile(join(repo, ".alden.toml"), "[learning]\nfromReviews = false\n");
    expect((await loadConfig(repo)).learning.fromReviews).toBe(true);
    await setConfigValue("learning.fromReviews", "false");
    expect((await loadConfig(repo)).learning.fromReviews).toBe(false);
  });
});

describe("queue scope", () => {
  it("comes from this machine's user config, and a repo's config can't change it", async () => {
    await writeFile(userConfigPath(), '[queue]\norgs = ["acme"]\nignore = ["acme/legacy"]\n');
    await writeFile(
      join(repo, ".alden.toml"),
      '[queue]\norgs = ["evil"]\nrepos = ["evil/x"]\nfastTrackMaxLines = 20\n',
    );
    const config = await loadConfig(repo);
    expect(config.queue.fastTrackMaxLines).toBe(20);
    expect(queueScope(config)).toEqual({ orgs: ["acme"], repos: [], ignore: ["acme/legacy"] });
  });

  it("gives way to --repo and --org for one run, but keeps what you ignore", async () => {
    await writeFile(userConfigPath(), '[queue]\norgs = ["acme"]\nignore = ["acme/legacy"]\n');
    const config = await loadConfig(repo);
    expect(queueScope(config, { repos: ["getalden/alden"], orgs: [] })).toEqual({
      orgs: [],
      repos: ["getalden/alden"],
      ignore: ["acme/legacy"],
    });
  });
});

describe("setConfigValue", () => {
  it("takes lists comma-separated or as JSON", async () => {
    await setConfigValue("queue.orgs", "acme, getalden");
    expect((await loadConfig(repo)).queue.orgs).toEqual(["acme", "getalden"]);
    await setConfigValue("queue.repos", '["acme/shop"]');
    expect((await loadConfig(repo)).queue.repos).toEqual(["acme/shop"]);
    await expect(setConfigValue("queue.repos", "not-a-repo")).rejects.toThrow(/owner\/name/);
  });

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
