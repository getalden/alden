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
  (store) => {
    store.exec(`
      -- Small facts about this install: its anonymous id, the salt for repo hashes, when it first ran.
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- Telemetry waiting to be sent (only ever written after you opt in), oldest first.
      CREATE TABLE telemetry (id TEXT PRIMARY KEY, at TEXT NOT NULL, event TEXT NOT NULL, properties TEXT NOT NULL);
    `);
  },
  (store) => {
    store.exec(`
      -- Comments you're writing on a PR, until you send them as one review or delete them. Never synced or exported.
      -- pr_key is "owner/repo#123" lowercased; anchor is the line's text and its neighbours, to find it again when
      -- the PR moves.
      CREATE TABLE drafts (
        id TEXT PRIMARY KEY,
        pr TEXT NOT NULL,
        pr_key TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        path TEXT,
        line INTEGER,
        side TEXT,
        anchor TEXT,
        body TEXT NOT NULL,
        source TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX drafts_by_pr ON drafts (pr_key, created_at);
      -- The places to look in each PR's latest briefing: what a review didn't comment on, and what a comment teaches.
      CREATE TABLE briefed_places (pr_key TEXT PRIMARY KEY, briefing_at TEXT NOT NULL, places TEXT NOT NULL);
    `);
  },
  (store) => {
    store.exec(`
      -- Multi-line comments and suggested changes. start_line is a range's first line (line is its last);
      -- suggestion is the replacement code ('' deletes the lines); lines is the commented lines' text when placed
      -- (a JSON array), to find a range again and to tell whether a suggestion still replaces the same code.
      ALTER TABLE drafts ADD COLUMN start_line INTEGER;
      ALTER TABLE drafts ADD COLUMN suggestion TEXT;
      ALTER TABLE drafts ADD COLUMN lines TEXT;
    `);
  },
  (store) => {
    store.exec(`
      -- Linked notes: a general note about code outside the PR's diff. link_to is the file, line and range it links
      -- to (JSON: { path, line?, startLine? }), at the draft's head_sha; path and line stay empty, as for any note.
      ALTER TABLE drafts ADD COLUMN link_to TEXT;
    `);
  },
  (store) => {
    store.exec(`
      -- The places Alden flagged that you actually saw (a guided step shown for 1.5 s, an E1 marker on screen for
      -- 1.5 s), so a review that approves without a word on one can count as a quiet "not worth my time". One row per
      -- PR, head and place; place_key is "checkId|path|line". Kept 90 days and for the last 200 PRs. Never synced or
      -- exported.
      CREATE TABLE IF NOT EXISTS seen_places (
        pr_key TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        place_key TEXT NOT NULL,
        check_id TEXT,
        path TEXT NOT NULL,
        line INTEGER,
        how TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        PRIMARY KEY (pr_key, head_sha, place_key)
      );
      CREATE INDEX IF NOT EXISTS seen_places_by_time ON seen_places (seen_at);
    `);
  },
  (store) => {
    store.exec(`
      -- Each line comment you sent, kept 30 days, to find its thread on GitHub again and see what came of it.
      -- review_id is the review GitHub made; path, line, start_line and side are where it went at head_sha;
      -- suggestion is its suggested code and lines the code it replaced (a JSON array); check_id the flagged place it
      -- was near. compared_head is the head a suggestion was last compared against; applied and resolved say an
      -- outcome was recorded.
      CREATE TABLE sent_comments (
        id INTEGER PRIMARY KEY,
        pr_key TEXT NOT NULL,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        review_id INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        path TEXT NOT NULL,
        line INTEGER NOT NULL,
        start_line INTEGER,
        side TEXT NOT NULL,
        suggestion TEXT,
        lines TEXT,
        check_id TEXT,
        comment_id INTEGER,
        compared_head TEXT,
        applied INTEGER NOT NULL DEFAULT 0,
        resolved INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX sent_comments_by_pr ON sent_comments (pr_key, sent_at);
      -- When each PR's outcomes were last asked of GitHub (at most once a day), at which head, and whether it was
      -- closed then (checked once after close, then never again).
      CREATE TABLE outcome_checks (pr_key TEXT PRIMARY KEY, checked_at TEXT NOT NULL, head_sha TEXT, closed INTEGER NOT NULL DEFAULT 0);
    `);
  },
  (store) => {
    store.exec(`
      -- Replies and resolves ride a review: in_reply_to is the thread's node id, resolve whether to resolve it once
      -- sent. drafted is JSON ({ checkId, title }) on a comment Alden drafted from a finding.
      ALTER TABLE drafts ADD COLUMN in_reply_to TEXT;
      ALTER TABLE drafts ADD COLUMN resolve INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE drafts ADD COLUMN drafted TEXT;
      -- Your notification level for one PR, overriding notifications.followUps until the PR is merged or closed.
      CREATE TABLE pr_watch (pr_key TEXT PRIMARY KEY, repo TEXT NOT NULL, number INTEGER NOT NULL, level TEXT NOT NULL, set_at TEXT NOT NULL);
      -- PRs you reviewed, as last seen: when GitHub said it changed, and the state that check found (JSON), so the next
      -- check knows what's new.
      CREATE TABLE follow_ups (
        pr_key TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        checked_at TEXT NOT NULL,
        updated_at TEXT,
        state TEXT NOT NULL
      );
      -- What happened on them, once each. notified once the desktop app has shown it (or it was below the PR's level).
      CREATE TABLE follow_up_events (
        id TEXT PRIMARY KEY,
        pr_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        at TEXT NOT NULL,
        event TEXT NOT NULL,
        notified INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX follow_up_events_pending ON follow_up_events (notified, at);
    `);
  },
  (store) => {
    store.exec(`
      -- How long each review took (stats.reviewTime): one row per review session of a PR, from first opening its
      -- briefing (any surface) until the review is sent; a later re-review is a new row. Durations and counts only,
      -- never text. opened_at is the first open, terminal_opened_at the latest open from a terminal or AI tool;
      -- active_ms is active time the UI measured (the PR pane visible and focused, idle stretches over 2 min left
      -- out), or at send, without any, the terminal's estimate (measured 0). Kept 120 days. Never synced or exported.
      CREATE TABLE review_sessions (
        id TEXT PRIMARY KEY,
        pr_key TEXT NOT NULL,
        surface TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        terminal_opened_at TEXT,
        ui INTEGER NOT NULL DEFAULT 0,
        active_ms INTEGER NOT NULL DEFAULT 0,
        measured INTEGER NOT NULL DEFAULT 0,
        model INTEGER NOT NULL DEFAULT 0,
        drafted INTEGER NOT NULL DEFAULT 0,
        drafted_by_alden INTEGER NOT NULL DEFAULT 0,
        kept INTEGER NOT NULL DEFAULT 0,
        places_seen INTEGER,
        sent_comments INTEGER,
        verdict TEXT,
        sent_at TEXT
      );
      CREATE INDEX review_sessions_open ON review_sessions (pr_key, sent_at);
      CREATE INDEX review_sessions_by_open ON review_sessions (opened_at);
    `);
  },
];

/** How many schema changes there are: the database's `user_version` once it's up to date. */
export const MIGRATION_COUNT = MIGRATIONS.length;

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
 * Alden's local database, `~/.alden/alden.db`: feedback, what you open, memory, spending, first use per repo, and the
 * comments you're drafting. SQLite in WAL mode, so the CLI and the UI can write at once. Nothing in it leaves the
 * machine, except the comments you send to GitHub yourself.
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

/** Closes every database this process opened, e.g. before a test deletes its folder (Windows won't delete open files). */
export function closeStores(): void {
  for (const store of [...opened.values()]) store.close();
}
