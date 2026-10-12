import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type AldenConfig, AldenConfigSchema, RANK_WEIGHTS, type RankRule, type RankWeight } from "@alden/schema";
import { parse, stringify } from "smol-toml";
import { z } from "zod";

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

export async function readToml(path: string): Promise<Table> {
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

/** Settings that describe you, not the repo: a repo's `.alden.toml` can't change them. */
const USER_ONLY = [
  ["queue", "orgs"],
  ["queue", "repos"],
  ["queue", "ignore"],
  ["queue", "rank"],
  ["clones", "folders"],
  ["notifications", "sound"],
  ["notifications", "followUps"],
  ["learning", "fromReviews"],
  ["drafts", "auto"],
] as const;

/** Defaults, then `~/.alden/config.toml`, then the repo's `.alden.toml` (except the user-only settings). */
export async function loadConfig(cwd: string = process.cwd()): Promise<AldenConfig> {
  const user = await readToml(userConfigPath());
  const repo = await readToml(repoConfigPath(cwd));
  for (const [table, key] of USER_ONLY) {
    const node = repo[table];
    if (isTable(node)) delete node[key];
  }
  return AldenConfigSchema.parse(deepMerge(user, repo));
}

/**
 * The queue's scope: `--repo` and `--org` for one run when given, else this machine's `queue.repos` and
 * `queue.orgs`; `queue.ignore` always applies.
 */
export function queueScope(
  config: AldenConfig,
  flags: { repos?: string[]; orgs?: string[] } = {},
): { repos: string[]; orgs: string[]; ignore: string[] } {
  const given = (flags.repos?.length ?? 0) + (flags.orgs?.length ?? 0) > 0;
  return {
    repos: given ? (flags.repos ?? []) : config.queue.repos,
    orgs: given ? (flags.orgs ?? []) : config.queue.orgs,
    ignore: config.queue.ignore,
  };
}

export function getConfigValue(config: AldenConfig, key: string): unknown {
  let node: unknown = config;
  for (const part of key.split(".")) {
    if (!isTable(node) || !(part in node)) return undefined;
    node = node[part];
  }
  return node;
}

/** A value from `alden config set`: lists are comma-separated ("a, b") or JSON ("[\"a\"]"). */
function coerce(raw: string, list = false): unknown {
  if (list) {
    if (raw.trim().startsWith("[")) return JSON.parse(raw);
    return raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
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
  node[last] = coerce(raw, Array.isArray(getConfigValue(AldenConfigSchema.parse({}), key)));

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

/** Removes a dotted key from the user config, so the default (or the repo's config) applies again. */
export async function unsetConfigValue(key: string): Promise<void> {
  const path = userConfigPath();
  const table = await readToml(path);
  const parts = key.split(".");
  const last = parts.pop();
  if (!last) throw new Error("Config key is empty.");
  if (!isKnownKey(key)) throw new Error(`Unknown config key: ${key}`);
  let node: Table | undefined = table;
  for (const part of parts) node = isTable(node?.[part]) ? (node?.[part] as Table) : undefined;
  if (!node || !(last in node)) return;
  delete node[last];
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringify(table), "utf8");
}

/** Whether a dotted key names a setting, including optional ones with no default (e.g. model.effort). */
export function isKnownKey(key: string): boolean {
  let node = z.toJSONSchema(AldenConfigSchema, { io: "input" }) as { properties?: Record<string, unknown> };
  for (const part of key.split(".")) {
    const next = node.properties?.[part] as { properties?: Record<string, unknown> } | undefined;
    if (!next) return false;
    node = next;
  }
  return true;
}

/**
 * Whether background briefings may ask the model. Read from the user config only: a repo's .alden.toml must never
 * make its contributors spend.
 */
export async function backgroundModelAllowed(): Promise<boolean> {
  try {
    const user = await readToml(userConfigPath());
    return (user.background as { model?: unknown } | undefined)?.model === true;
  } catch {
    return false;
  }
}

/** A change to how you rank the queue. A weight of null (or 1, the default) and an empty rule list are removed. */
export interface RankChange {
  weights?: Partial<Record<RankWeight, number | null>>;
  rules?: RankRule[];
  /** `background.prepare`: how many top PRs to keep briefed. null removes it, so the default (3) applies. */
  prepare?: number | null;
}

/**
 * Writes `[queue.rank]` (and `background.prepare`) to your user config, rejecting anything the schema would refuse,
 * so the file only ever holds what differs from the defaults.
 */
export async function setRankSettings(change: RankChange): Promise<void> {
  const path = userConfigPath();
  const table = await readToml(path);
  const queue = isTable(table.queue) ? table.queue : {};
  const rank = isTable(queue.rank) ? queue.rank : {};
  for (const [name, value] of Object.entries(change.weights ?? {})) {
    if (!(RANK_WEIGHTS as readonly string[]).includes(name)) throw new Error(`Unknown ranking weight: ${name}`);
    if (value === null || value === 1) delete rank[name];
    else rank[name] = value;
  }
  if (change.rules !== undefined) {
    if (change.rules.length === 0) delete rank.rules;
    // Only the fields a rule has: no undefined values for TOML to trip on.
    else rank.rules = JSON.parse(JSON.stringify(change.rules)) as unknown;
  }
  if (Object.keys(rank).length > 0) queue.rank = rank;
  else delete queue.rank;
  if (Object.keys(queue).length > 0) table.queue = queue;
  else delete table.queue;

  if (change.prepare !== undefined) {
    const background = isTable(table.background) ? table.background : {};
    if (change.prepare === null) delete background.prepare;
    else background.prepare = change.prepare;
    if (Object.keys(background).length > 0) table.background = background;
    else delete table.background;
  }

  const result = AldenConfigSchema.safeParse(table);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.join(".") ?? "";
    throw new Error(`Invalid ranking setting${where ? ` (${where})` : ""}: ${issue?.message ?? "rejected by schema"}`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringify(table), "utf8");
}
