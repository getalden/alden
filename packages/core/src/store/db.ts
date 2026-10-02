import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { aldenHome } from "../config.js";

const require = createRequire(import.meta.url);

/**
 * `node:sqlite`, without the "experimental feature" warning older Node versions print when it loads: Alden's users
 * can't act on it. Bun (and so the standalone binary) implements the same module.
 */
function loadSqlite(): typeof import("node:sqlite") {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (/SQLite is an experimental feature/.test(text)) return;
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } finally {
    process.emitWarning = emit;
  }
}

export type Row = Record<string, SQLInputValue>;

/**
 * Schema changes, applied in order; `PRAGMA user_version` records how many have run. Never edit one that has
 * shipped: add another.
 */
const MIGRATIONS: ((store: AldenStore) => void)[] = [
  (store) => {
    store.exec(`
      -- Append-only events (feedback, opens, memory), each with a unique id, so a later sync uploads what it hasn't.
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        repo TEXT,
        body TEXT NOT NULL,
        synced_at TEXT
      );
      CREATE INDEX events_by_type ON events (type, repo, at);
      CREATE TABLE spend (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        day TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        usd REAL,
        usage TEXT NOT NULL,
        purpose TEXT NOT NULL
      );
      CREATE INDEX spend_by_day ON spend (day);
      CREATE TABLE repos (repo TEXT PRIMARY KEY, first_used_at TEXT NOT NULL);
    `);
    importLegacyFiles(store);
  },
];

/** The JSON files Alden kept before the database, read once into it. */
const LEGACY = ["feedback", "spend", "usage.json"];

function jsonLines(dir: string): unknown[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .flatMap((file) =>
      readFileSync(join(dir, file), "utf8")
        .split("\n")
        .flatMap((line) => {
          try {
            return line.trim() ? [JSON.parse(line)] : [];
          } catch {
            return []; // a line cut short by a crash
          }
        }),
    );
}

function importLegacyFiles(store: AldenStore): void {
  const home = store.dir;
  for (const event of jsonLines(join(home, "feedback")) as { id?: string; at?: string; target?: { repo?: string } }[]) {
    if (typeof event.id !== "string" || typeof event.at !== "string") continue;
    store.run(
      "INSERT OR IGNORE INTO events (id, at, type, repo, body) VALUES (?, ?, 'feedback', ?, ?)",
      event.id,
      event.at,
      event.target?.repo?.toLowerCase() ?? null,
      JSON.stringify(event),
    );
  }
  for (const entry of jsonLines(join(home, "spend")) as Record<string, unknown>[]) {
    if (typeof entry.at !== "string") continue;
    store.run(
      "INSERT INTO spend (at, day, provider, model, usd, usage, purpose) VALUES (?, ?, ?, ?, ?, ?, ?)",
      entry.at,
      localDayOf(new Date(entry.at)),
      String(entry.provider ?? ""),
      String(entry.model ?? ""),
      typeof entry.usd === "number" ? entry.usd : null,
      JSON.stringify(entry.usage ?? {}),
      String(entry.purpose ?? ""),
    );
  }
  try {
    const usage = JSON.parse(readFileSync(join(home, "usage.json"), "utf8")) as { repos?: Record<string, string> };
    for (const [repo, at] of Object.entries(usage.repos ?? {})) {
      store.run("INSERT OR IGNORE INTO repos (repo, first_used_at) VALUES (?, ?)", repo.toLowerCase(), at);
    }
  } catch {
    // no usage file yet
  }
}

/** The local calendar day, YYYY-MM-DD. Duplicated from the ledger to keep the store free of imports from it. */
function localDayOf(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Alden's local database, `~/.alden/alden.db`: feedback, what you open, memory, spending and first use per repo.
 * SQLite in WAL mode, so the CLI and the UI can write at once. Nothing in it leaves the machine.
 */
export class AldenStore {
  private constructor(
    private readonly db: DatabaseSync,
    readonly path: string,
  ) {}

  /** The folder the database lives in. */
  get dir(): string {
    return dirname(this.path);
  }

  static open(path: string): AldenStore {
    mkdirSync(dirname(path), { recursive: true });
    const { DatabaseSync } = loadSqlite();
    const store = new AldenStore(new DatabaseSync(path), path);
    store.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    store.migrate();
    return store;
  }

  private migrate(): void {
    const version = () => Number(this.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0);
    if (version() >= MIGRATIONS.length) return;
    let imported = false;
    // IMMEDIATE takes the write lock first, so two Alden processes starting at once don't both migrate.
    this.exec("BEGIN IMMEDIATE");
    try {
      for (let v = version(); v < MIGRATIONS.length; v++) {
        MIGRATIONS[v]?.(this);
        if (v === 0) imported = true;
        this.exec(`PRAGMA user_version = ${v + 1}`);
      }
      this.exec("COMMIT");
    } catch (error) {
      this.exec("ROLLBACK");
      throw error;
    }
    // The old files are kept, out of the way, rather than deleted.
    if (imported) {
      for (const name of LEGACY) {
        const from = join(this.dir, name);
        if (!existsSync(from)) continue;
        try {
          mkdirSync(join(this.dir, "legacy"), { recursive: true });
          renameSync(from, join(this.dir, "legacy", name));
        } catch {
          // left where it is; it's never read again
        }
      }
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number } {
    const result = this.db.prepare(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return (this.db.prepare(sql).get(...params) ?? undefined) as T | undefined;
  }

  /** Runs `fn` in one transaction: all of it lands, or none. */
  transaction<T>(fn: () => T): T {
    this.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.exec("COMMIT");
      return out;
    } catch (error) {
      this.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
    for (const [path, store] of opened) if (store === this) opened.delete(path);
  }

  /** Appends an event. Ids are unique, so writing the same event twice is harmless. */
  addEvent(event: { id: string; at: string; type: string; repo: string | null; body: unknown }): void {
    this.run(
      "INSERT OR IGNORE INTO events (id, at, type, repo, body) VALUES (?, ?, ?, ?, ?)",
      event.id,
      event.at,
      event.type,
      event.repo?.toLowerCase() ?? null,
      JSON.stringify(event.body),
    );
  }

  /** Events of a type, oldest first, optionally for one repo and since a time. */
  events<T>(type: string, options: { repo?: string; since?: string } = {}): T[] {
    const where = ["type = ?"];
    const params: SQLInputValue[] = [type];
    if (options.repo !== undefined) {
      where.push("repo = ?");
      params.push(options.repo.toLowerCase());
    }
    if (options.since !== undefined) {
      where.push("at >= ?");
      params.push(options.since);
    }
    return this.all<{ body: string }>(
      `SELECT body FROM events WHERE ${where.join(" AND ")} ORDER BY at, rowid`,
      ...params,
    ).flatMap((row) => {
      try {
        return [JSON.parse(row.body) as T];
      } catch {
        return [];
      }
    });
  }
}

const opened = new Map<string, AldenStore>();

/** The database at `path` (by default `~/.alden/alden.db`), opened once per process. */
export function openStore(path: string = join(aldenHome(), "alden.db")): AldenStore {
  let store = opened.get(path);
  if (!store) {
    store = AldenStore.open(path);
    opened.set(path, store);
  }
  return store;
}
