import type { PriceStorage } from "./PriceStorage";
import { SqlitePriceStorage, type SqliteStorageOptions } from "./SqlitePriceStorage";
import { IndexedDbPriceStorage, type IndexedDbStorageOptions } from "./IndexedDbPriceStorage";
import { MemoryPriceStorage } from "./MemoryPriceStorage";

export interface CreatePriceStorageOptions {
  readonly driver?: "sqlite" | "indexeddb" | "memory" | "auto" | undefined;
  readonly sqlite?: SqliteStorageOptions | undefined;
  readonly indexedDb?: IndexedDbStorageOptions | undefined;
}

export function createPriceStorage(options: CreatePriceStorageOptions = {}): PriceStorage {
  const driver = options.driver ?? "auto";

  if (driver === "memory") {
    return new MemoryPriceStorage();
  }

  if (driver === "indexeddb") {
    return new IndexedDbPriceStorage(options.indexedDb);
  }

  if (driver === "sqlite") {
    return new SqlitePriceStorage(options.sqlite);
  }

  // Auto-detect environment
  if (typeof indexedDB !== "undefined") {
    try {
      return new IndexedDbPriceStorage(options.indexedDb);
    } catch {
      // Fall through to memory
    }
  }

  // Check for Node.js
  if (typeof process !== "undefined" && process.versions?.node) {
    return new SqlitePriceStorage(options.sqlite);
  }

  return new MemoryPriceStorage();
}
