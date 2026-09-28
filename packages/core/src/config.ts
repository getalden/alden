import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type AldenConfig, AldenConfigSchema } from "@alden/schema";
import { parse, stringify } from "smol-toml";

type Table = Record<string, unknown>;

/** Alden's home directory. `ALDEN_HOME` overrides it (used by tests). */
export function aldenHome(): string {
  return process.env.ALDEN_HOME ?? join(homedir(), ".alden");
}

export function userConfigPath(): string {
  return join(aldenHome(), "config.toml");
}

export function repoConfigPath(cwd: string = process.cwd()): string {
  return join(cwd, ".alden.toml");
}

async function readToml(path: string): Promise<Table> {
  if (!existsSync(path)) return {};
  return parse(await readFile(path, "utf8")) as Table;
}

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: Table, override: Table): Table {
  const out: Table = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    out[key] = isTable(existing) && isTable(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

/** Defaults, then `~/.alden/config.toml`, then the repo's `.alden.toml`. */
export async function loadConfig(cwd: string = process.cwd()): Promise<AldenConfig> {
  const user = await readToml(userConfigPath());
  const repo = await readToml(repoConfigPath(cwd));
  return AldenConfigSchema.parse(deepMerge(user, repo));
}

export function getConfigValue(config: AldenConfig, key: string): unknown {
  let node: unknown = config;
  for (const part of key.split(".")) {
    if (!isTable(node) || !(part in node)) return undefined;
    node = node[part];
  }
  return node;
}

function coerce(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.trim() !== "" && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

/** Sets a dotted key in the user config, rejecting values the schema would refuse. */
export async function setConfigValue(key: string, raw: string): Promise<void> {
  const path = userConfigPath();
  const table = await readToml(path);
  const parts = key.split(".");
  const last = parts.pop();
  if (!last) throw new Error("Config key is empty.");

  let node = table;
  for (const part of parts) {
    const next = node[part];
    node[part] = isTable(next) ? next : {};
    node = node[part] as Table;
  }
  node[last] = coerce(raw);

  const result = AldenConfigSchema.safeParse(table);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`Invalid value for ${key}: ${issue?.message ?? "rejected by schema"}`);
  }
  if (getConfigValue(result.data, key) === undefined) {
    throw new Error(`Unknown config key: ${key}`);
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringify(table), "utf8");
}
