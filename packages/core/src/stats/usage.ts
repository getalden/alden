import { type StoreSource, storeFrom } from "../store/source.js";

/**
 * When Alden was first used on each repo, so `alden stats` can split before from after. Only the first date per
 * repo is ever written.
 */
export class UsageLog {
  constructor(private readonly source?: StoreSource) {}

  /** Notes a use of `repo` ("owner/name"), keeping the earliest. */
  async markUsed(repo: string, at: Date = new Date()): Promise<void> {
    storeFrom(this.source).run(
      "INSERT OR IGNORE INTO repos (repo, first_used_at) VALUES (?, ?)",
      repo.toLowerCase(),
      at.toISOString(),
    );
  }

  async firstUse(repo: string): Promise<Date | undefined> {
    const row = storeFrom(this.source).get<{ first_used_at: string }>(
      "SELECT first_used_at FROM repos WHERE repo = ?",
      repo.toLowerCase(),
    );
    return row ? new Date(row.first_used_at) : undefined;
  }
}
