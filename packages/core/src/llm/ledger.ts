import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { aldenHome } from "../config.js";
import type { TokenUsage } from "./models.js";

/** One paid (or local) model call, as recorded in the spend ledger. */
export interface SpendEntry {
  at: string;
  provider: string;
  model: string;
  /** Undefined when Alden doesn't know the model's price (local models, cloud-provider billing). */
  usd?: number;
  usage: TokenUsage;
  /** What the call was for, e.g. "getalden/alden#12" or "local changes". */
  purpose: string;
}

/** The local calendar day, YYYY-MM-DD: budgets reset at the user's midnight, not UTC's. */
export function localDay(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Spending, one append-only JSON-lines file per day in `~/.alden/spend`. Appends of a single short line don't
 * interleave, so two Alden processes can record at once without losing entries.
 */
export class SpendLedger {
  constructor(private readonly dir: string = join(aldenHome(), "spend")) {}

  private file(day: string): string {
    return join(this.dir, `${day}.jsonl`);
  }

  async record(entry: SpendEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file(localDay(new Date(entry.at))), `${JSON.stringify(entry)}\n`, "utf8");
  }

  /** Entries for one day. Lines that don't parse (a crash mid-write) are skipped rather than failing. */
  async entries(day: string = localDay()): Promise<SpendEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file(day), "utf8");
    } catch {
      return [];
    }
    return text
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as SpendEntry];
        } catch {
          return [];
        }
      });
  }

  /** Known spending on a day, in USD. Calls with unknown prices add nothing. */
  async spentOn(day: string = localDay()): Promise<number> {
    return (await this.entries(day)).reduce((sum, e) => sum + (e.usd ?? 0), 0);
  }

  /** The days that have a ledger file, newest first. */
  async days(): Promise<string[]> {
    try {
      return (await readdir(this.dir))
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .map((f) => f.slice(0, 10))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }
}
