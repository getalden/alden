import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { aldenHome } from "./config.js";

interface Entry<T> {
  storedAt: number;
  value: T;
}

/** A small on-disk JSON cache in `~/.alden/cache`, one file per key. */
export class JsonCache {
  constructor(
    private readonly dir: string = join(aldenHome(), "cache"),
    private readonly now: () => number = Date.now,
  ) {}

  private pathFor(key: string): string {
    return join(this.dir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
  }

  /** The cached value, or undefined if it is missing, unreadable, or older than `maxAgeMs`. */
  async get<T>(key: string, maxAgeMs: number): Promise<T | undefined> {
    const path = this.pathFor(key);
    if (!existsSync(path)) return undefined;
    try {
      const entry = JSON.parse(await readFile(path, "utf8")) as Entry<T>;
      return this.now() - entry.storedAt <= maxAgeMs ? entry.value : undefined;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const entry: Entry<T> = { storedAt: this.now(), value };
    await writeFile(this.pathFor(key), JSON.stringify(entry), "utf8");
  }

  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
