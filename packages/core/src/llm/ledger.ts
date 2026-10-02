import { type StoreSource, storeFrom } from "../store/source.js";
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

/** Spending, one row per model call in Alden's local database, by the local day it happened. */
export class SpendLedger {
  constructor(private readonly source?: StoreSource) {}

  async record(entry: SpendEntry): Promise<void> {
    storeFrom(this.source).run(
      "INSERT INTO spend (at, day, provider, model, usd, usage, purpose) VALUES (?, ?, ?, ?, ?, ?, ?)",
      entry.at,
      localDay(new Date(entry.at)),
      entry.provider,
      entry.model,
      entry.usd ?? null,
      JSON.stringify(entry.usage),
      entry.purpose,
    );
  }

  /** Entries for one day, oldest first. */
  async entries(day: string = localDay()): Promise<SpendEntry[]> {
    return storeFrom(this.source)
      .all<{ at: string; provider: string; model: string; usd: number | null; usage: string; purpose: string }>(
        "SELECT at, provider, model, usd, usage, purpose FROM spend WHERE day = ? ORDER BY at, id",
        day,
      )
      .map((row) => ({
        at: row.at,
        provider: row.provider,
        model: row.model,
        ...(row.usd === null ? {} : { usd: row.usd }),
        usage: JSON.parse(row.usage) as TokenUsage,
        purpose: row.purpose,
      }));
  }

  /** Known spending on a day, in USD. Calls with unknown prices add nothing. */
  async spentOn(day: string = localDay()): Promise<number> {
    const row = storeFrom(this.source).get<{ usd: number | null }>(
      "SELECT SUM(usd) AS usd FROM spend WHERE day = ?",
      day,
    );
    return row?.usd ?? 0;
  }

  /** The days with any spending, newest first. */
  async days(): Promise<string[]> {
    return storeFrom(this.source)
      .all<{ day: string }>("SELECT DISTINCT day FROM spend ORDER BY day DESC")
      .map((row) => row.day);
  }
}
