import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  TELEMETRY_SCHEMA_VERSION,
  type TelemetryCommon,
  type TelemetryEventName,
  TelemetryEventSchema,
  type TelemetryProperties,
} from "@alden/schema";
import { readToml, setConfigValue, userConfigPath } from "../config.js";
import { isStandaloneBinary } from "../embedded.js";
import type { AldenStore } from "../store/db.js";
import { openStore } from "../store/db.js";

/**
 * Opt-in usage telemetry, sent to PostHog (EU) in batches. Off until the user says yes; forced off by DO_NOT_TRACK,
 * ALDEN_TELEMETRY=0 and CI. Events are checked against the published schema (packages/schema/src/telemetry.ts)
 * before they're queued, so nothing outside it can be sent.
 */

/** PostHog's EU ingestion host. */
export const TELEMETRY_HOST = "https://eu.i.posthog.com";
/**
 * The PostHog project's public key (a "phc_" token: it names the project and can only send events, so it isn't a
 * secret). `ALDEN_TELEMETRY_KEY` overrides it, e.g. to point a test build at another project.
 */
export const TELEMETRY_KEY = "phc_qkSGWofnv9C9YLomkc3jAPbDfVe8hFEsy6dCzbsfj9Mb";
/** The most events kept waiting; older ones are dropped first. */
export const MAX_QUEUED = 5_000;
const BATCH = 200;

export type Consent = "on" | "off" | "unset";

/** Why telemetry is forced off here, if it is: shown by `alden telemetry` and the UI. */
export function telemetryBlocked(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.DO_NOT_TRACK && env.DO_NOT_TRACK !== "0") return "DO_NOT_TRACK is set";
  if (env.ALDEN_TELEMETRY === "0" || env.ALDEN_TELEMETRY === "false") return "ALDEN_TELEMETRY=0 is set";
  if (env.CI && env.CI !== "false") return "running in CI";
  return undefined;
}

/**
 * The user's answer. Read from the user config only: a repo's .alden.toml must never opt its contributors in.
 */
export async function telemetryConsent(env: NodeJS.ProcessEnv = process.env): Promise<Consent> {
  if (telemetryBlocked(env)) return "off";
  try {
    const user = await readToml(userConfigPath());
    const enabled = (user.telemetry as { enabled?: unknown } | undefined)?.enabled;
    return enabled === true ? "on" : enabled === false ? "off" : "unset";
  } catch {
    return "off";
  }
}

/** Saves the user's answer. Turning it off also drops anything still waiting to be sent. */
export async function setTelemetryConsent(on: boolean, store?: AldenStore): Promise<void> {
  await setConfigValue("telemetry.enabled", on ? "true" : "false");
  const db = store ?? openStore();
  if (on) {
    context.consent = "on";
    await track("telemetry_enabled", {}, db);
  } else {
    context.consent = "off";
    db.run("DELETE FROM telemetry");
  }
}

function meta(store: AldenStore, key: string, make: () => string): string {
  const row = store.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key);
  if (row) return row.value;
  const value = make();
  store.run("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", key, value);
  return store.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value ?? value;
}

/** This install's anonymous id: a random UUID, not derived from anything about you. */
export function installId(store: AldenStore = openStore()): string {
  return meta(store, "install_id", randomUUID);
}

/** A repo as a hash that can be counted but not reversed: the salt is random and never leaves this machine. */
export function repoHash(repo: string, store: AldenStore = openStore()): string {
  const salt = meta(store, "repo_salt", () => randomBytes(32).toString("hex"));
  return createHash("sha256").update(`${salt}:${repo.toLowerCase()}`).digest("hex").slice(0, 16);
}

const context: { version: string; surface: TelemetryCommon["surface"]; consent?: Consent | undefined } = {
  version: "0.0.0",
  surface: "cli",
};

/** Called once at startup by the CLI, the UI server or the desktop app. */
export function configureTelemetry(options: { version: string; surface: TelemetryCommon["surface"] }): void {
  context.version = options.version;
  context.surface = options.surface;
  context.consent = undefined;
}

/** Where this process runs, as `configureTelemetry` was told: which surface a briefing was opened on, too. */
export function telemetrySurface(): TelemetryCommon["surface"] {
  return context.surface;
}

function common(store: AldenStore): TelemetryCommon {
  const first = meta(store, "installed_at", () => new Date().toISOString());
  const os = process.platform === "darwin" || process.platform === "linux" || process.platform === "win32";
  return {
    schema: TELEMETRY_SCHEMA_VERSION,
    app_version: context.version,
    surface: context.surface,
    runtime: isStandaloneBinary() ? "binary" : "node",
    os: os ? (process.platform as TelemetryCommon["os"]) : "other",
    arch: process.arch,
    install_age_days: Math.max(0, Math.floor((Date.now() - Date.parse(first)) / 86_400_000)),
  };
}

/**
 * Queues an event if the user opted in. Never throws and never blocks on the network: telemetry must not get in the
 * way of a review. An event that doesn't match the schema is dropped.
 */
export async function track<E extends TelemetryEventName>(
  event: E,
  properties: TelemetryProperties<E>,
  store?: AldenStore,
): Promise<void> {
  try {
    context.consent ??= await telemetryConsent();
    if (context.consent !== "on") return;
    const parsed = TelemetryEventSchema.safeParse({ event, properties });
    if (!parsed.success) return;
    const db = store ?? openStore();
    db.run(
      "INSERT INTO telemetry (id, at, event, properties) VALUES (?, ?, ?, ?)",
      randomUUID(),
      new Date().toISOString(),
      event,
      JSON.stringify({ ...common(db), ...parsed.data.properties }),
    );
    db.run(
      "DELETE FROM telemetry WHERE id IN (SELECT id FROM telemetry ORDER BY at DESC LIMIT -1 OFFSET ?)",
      MAX_QUEUED,
    );
  } catch {
    // never let telemetry break the command
  }
}

/** What's waiting to be sent, oldest first, as `alden telemetry show` prints it. */
export function queuedTelemetry(store: AldenStore = openStore()): { at: string; event: string; properties: unknown }[] {
  return store
    .all<{ at: string; event: string; properties: string }>("SELECT at, event, properties FROM telemetry ORDER BY at")
    .map((row) => ({ at: row.at, event: row.event, properties: JSON.parse(row.properties) as unknown }));
}

/**
 * Sends what's queued, in batches, and deletes what PostHog accepted. Returns how many were sent. Gives up quietly
 * (keeping the events) when offline, slow, or without a project key.
 */
export async function flushTelemetry(
  options: { store?: AldenStore; timeoutMs?: number; fetcher?: typeof fetch; key?: string } = {},
): Promise<number> {
  try {
    const key = options.key ?? process.env.ALDEN_TELEMETRY_KEY ?? TELEMETRY_KEY;
    if (!key || (await telemetryConsent()) !== "on") return 0;
    const db = options.store ?? openStore();
    const id = installId(db);
    const fetcher = options.fetcher ?? fetch;
    let sent = 0;
    for (;;) {
      const rows = db.all<{ id: string; at: string; event: string; properties: string }>(
        "SELECT id, at, event, properties FROM telemetry ORDER BY at LIMIT ?",
        BATCH,
      );
      if (rows.length === 0) return sent;
      const body = {
        api_key: key,
        batch: rows.map((row) => ({
          event: row.event,
          timestamp: row.at,
          properties: {
            ...(JSON.parse(row.properties) as Record<string, unknown>),
            distinct_id: id,
            // Anonymous: no person profile, no IP-based location.
            $process_person_profile: false,
            $ip: null,
            $lib: "alden",
          },
        })),
      };
      const res = await fetcher(`${TELEMETRY_HOST}/batch/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
      });
      if (!res.ok) return sent;
      const ids = rows.map((r) => r.id);
      db.run(`DELETE FROM telemetry WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
      sent += rows.length;
      if (rows.length < BATCH) return sent;
    }
  } catch {
    return 0;
  }
}
