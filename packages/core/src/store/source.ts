import { AldenStore, openStore } from "./db.js";

/** Where a log keeps its data: a store, a database file's path, or (by default) `~/.alden/alden.db`. */
export type StoreSource = AldenStore | string | undefined;

/** Opens lazily, so building a log doesn't touch the disk until it's used. */
export function storeFrom(source: StoreSource): AldenStore {
  return source instanceof AldenStore ? source : openStore(source);
}
