import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeStores, openStore } from "../store/db.js";
import { signalsEvent } from "./events.js";
import {
  configureTelemetry,
  flushTelemetry,
  installId,
  queuedTelemetry,
  repoHash,
  setTelemetryConsent,
  telemetryBlocked,
  telemetryConsent,
  track,
} from "./telemetry.js";

let home: string;
const saved = { ...process.env };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "alden-telemetry-"));
  process.env.ALDEN_HOME = home;
  delete process.env.CI;
  delete process.env.DO_NOT_TRACK;
  delete process.env.ALDEN_TELEMETRY;
  configureTelemetry({ version: "1.2.3", surface: "cli" });
});
afterEach(() => {
  closeStores();
  process.env = { ...saved };
  rmSync(home, { recursive: true, force: true });
});

const review = {
  target: "pr" as const,
  repo_hash: null,
  files: 3,
  lines: 40,
  languages: ["typescript"],
  graph: true,
  callers: 2,
  checks_flagged: 1,
  places: 1,
  hidden_by_feedback: 0,
  notes_used: 0,
  llm_status: "none" as const,
  model: null,
  usd: null,
  duration_ms: 1200,
};

describe("consent", () => {
  it("is unset until answered, and read only from the user config, never a repo's", async () => {
    const repo = mkdtempSync(join(tmpdir(), "alden-repo-"));
    writeFileSync(join(repo, ".alden.toml"), "[telemetry]\nenabled = true\n");
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      expect(await telemetryConsent()).toBe("unset");
    } finally {
      process.chdir(cwd);
      rmSync(repo, { recursive: true, force: true });
    }
    await setTelemetryConsent(true);
    expect(await telemetryConsent()).toBe("on");
  });

  it("is forced off by DO_NOT_TRACK, ALDEN_TELEMETRY=0 and CI", async () => {
    await setTelemetryConsent(true);
    expect(telemetryBlocked({ DO_NOT_TRACK: "1" })).toBe("DO_NOT_TRACK is set");
    expect(telemetryBlocked({ ALDEN_TELEMETRY: "0" })).toBe("ALDEN_TELEMETRY=0 is set");
    expect(telemetryBlocked({ CI: "true" })).toBe("running in CI");
    expect(telemetryBlocked({})).toBeUndefined();
    expect(await telemetryConsent({ CI: "1" })).toBe("off");
  });
});

describe("tracking", () => {
  it("queues nothing before you opt in", async () => {
    await track("review_completed", review);
    expect(queuedTelemetry()).toEqual([]);
  });

  it("queues schema-checked events with the common properties, and drops anything outside the schema", async () => {
    await setTelemetryConsent(true);
    await track("review_completed", review);
    // A property the schema doesn't list (a repo name) is stripped; a wrong type drops the event.
    await track("reaction_given", { reaction: "up", repo: "acme/secret" } as never);
    await track("command_run", { command: "review", ok: "yes", duration_ms: 1 } as never);
    const events = queuedTelemetry();
    expect(events.map((e) => e.event)).toEqual(["telemetry_enabled", "review_completed", "reaction_given"]);
    expect(events[1]?.properties).toMatchObject({
      schema: 1,
      app_version: "1.2.3",
      surface: "cli",
      runtime: "node",
      install_age_days: 0,
      files: 3,
    });
    expect(JSON.stringify(events[2])).not.toContain("acme/secret");
  });

  it("counts what a review taught by kind, never where", async () => {
    await setTelemetryConsent(true);
    const signals = [
      { signal: "suggestion" as const, path: "src/secret-plan.ts", checkId: "tests.missing" },
      { signal: "miss" as const, path: "src/secret-plan.ts" },
      { signal: "miss" as const },
    ];
    await track("review_signals", signalsEvent(signals, "review"));
    const [, event] = queuedTelemetry();
    expect(event?.properties).toMatchObject({
      source: "review",
      suggestion: 1,
      miss: 2,
      comment: 0,
      silent_pass: 0,
      request_changes: 0,
      applied: 0,
      resolved: 0,
    });
    expect(JSON.stringify(event)).not.toMatch(/secret-plan|tests\.missing/);
  });

  it("hashes repos with a local salt: stable here, unguessable elsewhere", () => {
    const a = repoHash("Acme/Shop");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(repoHash("acme/shop")).toBe(a);
    expect(repoHash("acme/other")).not.toBe(a);
    // Another install has another salt.
    closeStores();
    const other = mkdtempSync(join(tmpdir(), "alden-telemetry-"));
    process.env.ALDEN_HOME = other;
    expect(repoHash("acme/shop")).not.toBe(a);
    closeStores();
    rmSync(other, { recursive: true, force: true });
  });

  it("drops what's waiting when you opt out", async () => {
    await setTelemetryConsent(true);
    await track("reaction_given", { reaction: "down" });
    await setTelemetryConsent(false);
    expect(queuedTelemetry()).toEqual([]);
    await track("reaction_given", { reaction: "down" });
    expect(queuedTelemetry()).toEqual([]);
  });
});

describe("sending", () => {
  it("sends anonymous batches to PostHog EU and deletes what was accepted", async () => {
    await setTelemetryConsent(true);
    for (let i = 0; i < 3; i++) await track("pr_opened", { position: i });
    const requests: {
      url: string;
      body: { api_key: string; batch: { event: string; properties: Record<string, unknown> }[] };
    }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(init.body as string) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await flushTelemetry({ fetcher, key: "phc_test" })).toBe(4);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://eu.i.posthog.com/batch/");
    expect(requests[0]?.body.api_key).toBe("phc_test");
    expect(requests[0]?.body.batch[1]?.properties).toMatchObject({
      distinct_id: installId(),
      $process_person_profile: false,
      position: 0,
    });
    expect(queuedTelemetry()).toEqual([]);
  });

  it("keeps events when there's no key, PostHog refuses, or the network fails", async () => {
    await setTelemetryConsent(true);
    expect(await flushTelemetry({ key: "" })).toBe(0);
    const refuse = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    expect(await flushTelemetry({ fetcher: refuse, key: "phc_test" })).toBe(0);
    const offline = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await flushTelemetry({ fetcher: offline, key: "phc_test" })).toBe(0);
    expect(queuedTelemetry().map((e) => e.event)).toEqual(["telemetry_enabled"]);
    expect(openStore()).toBeTruthy();
  });
});
