import type {
  ArchiveCacheStoreInterface,
  PricePointRecord,
  PriceStorage,
  PriceSyncStoreInterface,
  QueryPointParams,
  QueryPointResult,
  SyncScopeRecord,
  TokenSupportStoreInterface,
} from "./PriceStorage";
import type { TokenSupportProvider, TokenSupportRecord } from "../domain/tokenSupportModels";
import { storageError } from "../domain/errors";

export interface IndexedDbStorageOptions {
  readonly dbName?: string | undefined;
  readonly customIndexedDb?: IDBFactory | undefined;
}

export class IndexedDbPriceStorage implements PriceStorage {
  readonly driver = "indexeddb" as const;
  private readonly dbName: string;
  private readonly idbFactory: IDBFactory;
  private db: IDBDatabase | null = null;

  constructor(options: IndexedDbStorageOptions = {}) {
    this.dbName = options.dbName ?? "token_price_db";
    const globalIdb = typeof indexedDB !== "undefined" ? indexedDB : undefined;
    const factory = options.customIndexedDb ?? globalIdb;
    if (!factory) {
      throw storageError("IndexedDB is not supported in the current environment.");
    }
    this.idbFactory = factory;
  }

  async initialize(): Promise<void> {
    if (this.db !== null) return;

    return new Promise((resolve, reject) => {
      const request = this.idbFactory.open(this.dbName, 1);

      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // 1. token_support store
        if (!db.objectStoreNames.contains("token_support")) {
          const store = db.createObjectStore("token_support", { keyPath: ["token", "provider"] });
          store.createIndex("token", "token", { unique: false });
        }

        // 2. price_sync_scopes store
        if (!db.objectStoreNames.contains("price_sync_scopes")) {
          db.createObjectStore("price_sync_scopes", { keyPath: "scope_key" });
        }

        // 3. price_points store
        if (!db.objectStoreNames.contains("price_points")) {
          const store = db.createObjectStore("price_points", { keyPath: ["scope_key", "timestamp"] });
          store.createIndex("scope_key", "scope_key", { unique: false });
          store.createIndex("timestamp", "timestamp", { unique: false });
          store.createIndex("scope_timestamp", ["scope_key", "timestamp"], { unique: true });
        }

        // 4. kline_archive store
        if (!db.objectStoreNames.contains("kline_archive")) {
          const store = db.createObjectStore("kline_archive", { keyPath: "cache_key" });
          store.createIndex("updated_at", "updated_at", { unique: false });
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onerror = () => {
        reject(storageError("Failed to open IndexedDB database.", request.error));
      };
    });
  }

  private getDb(): IDBDatabase {
    if (!this.db) throw storageError("IndexedDB price storage is not initialized.");
    return this.db;
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  readonly tokenSupport: TokenSupportStoreInterface = {
    loadAll: async (): Promise<readonly TokenSupportRecord[]> => {
      const db = this.getDb();
      return new Promise((resolve) => {
        try {
          const tx = db.transaction("token_support", "readonly");
          const store = tx.objectStore("token_support");
          const req = store.getAll();
          req.onsuccess = () => {
            const rows = req.result || [];
            resolve(rows.map((r: any) => ({
              token: r.token,
              provider: r.provider,
              supported: Boolean(r.supported),
              updatedAt: r.updated_at,
            })));
          };
          req.onerror = () => resolve([]);
        } catch {
          resolve([]);
        }
      });
    },

    get: async (token: string, provider: TokenSupportProvider): Promise<TokenSupportRecord | null> => {
      const db = this.getDb();
      return new Promise((resolve) => {
        try {
          const tx = db.transaction("token_support", "readonly");
          const store = tx.objectStore("token_support");
          const req = store.get([token.toUpperCase(), provider]);
          req.onsuccess = () => {
            const row = req.result;
            if (!row) return resolve(null);
            resolve({
              token: row.token,
              provider: row.provider,
              supported: Boolean(row.supported),
              updatedAt: row.updated_at,
            });
          };
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    },

    set: async (token: string, provider: TokenSupportProvider, supported: boolean): Promise<void> => {
      const db = this.getDb();
      return new Promise((resolve) => {
        try {
          const tx = db.transaction("token_support", "readwrite");
          const store = tx.objectStore("token_support");
          store.put({
            token: token.toUpperCase(),
            provider,
            supported: supported ? 1 : 0,
            updated_at: new Date().toISOString(),
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    },

    setBatch: async (records: readonly { token: string; provider: TokenSupportProvider; supported: boolean }[]): Promise<void> => {
      if (records.length === 0) return;
      const db = this.getDb();
      return new Promise((resolve) => {
        try {
          const tx = db.transaction("token_support", "readwrite");
          const store = tx.objectStore("token_support");
          const nowIso = new Date().toISOString();
          for (const r of records) {
            store.put({
              token: r.token.toUpperCase(),
              provider: r.provider,
              supported: r.supported ? 1 : 0,
              updated_at: nowIso,
            });
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    },
  };

  readonly priceSync: PriceSyncStoreInterface = {
    getScope: async (scopeKey: string): Promise<SyncScopeRecord | null> => {
      const db = this.getDb();
      return new Promise((resolve) => {
        try {
          const tx = db.transaction("price_sync_scopes", "readonly");
          const store = tx.objectStore("price_sync_scopes");
          const req = store.get(scopeKey);
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    },

    setScope: async (scopeKey: string, nextFrom: string, targetTo: string | null): Promise<void> => {
      const db = this.getDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("price_sync_scopes", "readwrite");
        const store = tx.objectStore("price_sync_scopes");
        store.put({
          scope_key: scopeKey,
          next_from: nextFrom,
          target_to: targetTo,
          updated_at: new Date().toISOString(),
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(storageError("Failed to set price sync scope in IndexedDB.", tx.error));
      });
    },

    deleteScope: async (scopeKey: string): Promise<void> => {
      const db = this.getDb();
      return new Promise((resolve) => {
        try {
          const tx = db.transaction("price_sync_scopes", "readwrite");
          tx.objectStore("price_sync_scopes").delete(scopeKey);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    },

    savePoints: async (
      scopeKey: string,
      points: readonly { timestamp: string; payload: unknown }[],
      replaceRange?: { from: string; to: string },
    ): Promise<void> => {
      const db = this.getDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("price_points", "readwrite");
        const store = tx.objectStore("price_points");

        if (replaceRange) {
          const range = IDBKeyRange.bound(
            [scopeKey, replaceRange.from],
            [scopeKey, replaceRange.to],
            false,
            true, // upperOpen = true
          );
          store.delete(range);
        }

        for (const pt of points) {
          const payloadStr = typeof pt.payload === "string" ? pt.payload : JSON.stringify(pt.payload);
          store.put({
            scope_key: scopeKey,
            timestamp: pt.timestamp,
            payload: payloadStr,
          });
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(storageError("Failed to save price points in IndexedDB.", tx.error));
      });
    },

    deletePoints: async (scopeKey: string, from?: string, to?: string): Promise<void> => {
      const db = this.getDb();
      return new Promise((resolve) => {
        try {
          const tx = db.transaction("price_points", "readwrite");
          const store = tx.objectStore("price_points");
          if (from !== undefined && to !== undefined) {
            const range = IDBKeyRange.bound([scopeKey, from], [scopeKey, to], false, true);
            store.delete(range);
          } else {
            const range = IDBKeyRange.bound([scopeKey, ""], [scopeKey, "\uffff"]);
            store.delete(range);
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    },

    queryPoint: async (params: QueryPointParams): Promise<QueryPointResult | null> => {
      const db = this.getDb();
      const interval = params.interval ?? "5m";
      const scopeKey = params.scopeKey ?? (params.exchange ? `${params.tokenKey}:${params.exchange}:${params.market ?? ""}:${params.quote ?? ""}:${interval}` : null);
      const requestedIso = params.timestamp;
      const requestedMs = Date.parse(requestedIso);

      const findSingle = (direction: "before" | "after"): Promise<PricePointRecord | null> => {
        return new Promise((resolve) => {
          try {
            const tx = db.transaction("price_points", "readonly");
            const store = tx.objectStore("price_points");
            if (scopeKey) {
              const index = store.index("scope_timestamp");
              let range: IDBKeyRange;
              if (params.maxDistanceMs !== undefined && Number.isFinite(params.maxDistanceMs)) {
                if (direction === "before") {
                  const lowerIso = new Date(Math.max(0, requestedMs - params.maxDistanceMs)).toISOString();
                  range = IDBKeyRange.bound([scopeKey, lowerIso], [scopeKey, requestedIso]);
                } else {
                  const upperIso = new Date(requestedMs + params.maxDistanceMs).toISOString();
                  range = IDBKeyRange.bound([scopeKey, requestedIso], [scopeKey, upperIso]);
                }
              } else {
                range =
                  direction === "before"
                    ? IDBKeyRange.bound([scopeKey, ""], [scopeKey, requestedIso])
                    : IDBKeyRange.bound([scopeKey, requestedIso], [scopeKey, "\uffff"]);
              }
              const cursorDir = direction === "before" ? "prev" : "next";

              const req = index.openCursor(range, cursorDir);
              req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) return resolve(null);
                resolve(cursor.value as PricePointRecord);
              };
              req.onerror = () => resolve(null);
            } else {
              // Prefix search on tokenKey across scopes: search timestamp index
              const index = store.index("timestamp");
              const tokenPrefix = `${params.tokenKey}:`;
              let range: IDBKeyRange;
              if (params.maxDistanceMs !== undefined && Number.isFinite(params.maxDistanceMs)) {
                if (direction === "before") {
                  const lowerIso = new Date(Math.max(0, requestedMs - params.maxDistanceMs)).toISOString();
                  range = IDBKeyRange.bound(lowerIso, requestedIso);
                } else {
                  const upperIso = new Date(requestedMs + params.maxDistanceMs).toISOString();
                  range = IDBKeyRange.bound(requestedIso, upperIso);
                }
              } else {
                range =
                  direction === "before"
                    ? IDBKeyRange.upperBound(requestedIso)
                    : IDBKeyRange.lowerBound(requestedIso);
              }
              const cursorDir = direction === "before" ? "prev" : "next";

              const req = index.openCursor(range, cursorDir);
              req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) return resolve(null);
                const val = cursor.value as PricePointRecord;
                if (val.scope_key.startsWith(tokenPrefix)) {
                  resolve(val);
                } else {
                  cursor.continue();
                }
              };
              req.onerror = () => resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      };

      const [before, after] = await Promise.all([
        params.direction === "after" ? Promise.resolve(null) : findSingle("before"),
        params.direction === "before" ? Promise.resolve(null) : findSingle("after"),
      ]);

      let selected: PricePointRecord | null = null;
      if (params.direction === "before") {
        selected = before;
      } else if (params.direction === "after") {
        selected = after;
      } else {
        if (!before) selected = after;
        else if (!after) selected = before;
        else {
          const diffB = Math.abs(Date.parse(before.timestamp) - requestedMs);
          const diffA = Math.abs(Date.parse(after.timestamp) - requestedMs);
          selected = diffB <= diffA ? before : after;
        }
      }

      if (!selected) return null;

      if (params.maxDistanceMs !== undefined) {
        const diff = Math.abs(Date.parse(selected.timestamp) - requestedMs);
        if (diff > params.maxDistanceMs) return null;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(selected.payload);
      } catch {
        payload = selected.payload;
      }

      return {
        scopeKey: selected.scope_key,
        timestamp: selected.timestamp,
        payload,
      };
    },

    resetSync: async (scopeKey: string): Promise<void> => {
      const db = this.getDb();
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(["price_points", "price_sync_scopes"], "readwrite");
          const pointStore = tx.objectStore("price_points");
          const scopeStore = tx.objectStore("price_sync_scopes");
          const range = IDBKeyRange.bound([scopeKey, ""], [scopeKey, "\uffff"]);
          pointStore.delete(range);
          scopeStore.delete(scopeKey);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    },
  };

  readonly archiveCache: ArchiveCacheStoreInterface = {
    getArchive: async (key: string, ttlMs: number = 0): Promise<Uint8Array | null> => {
      const db = this.getDb();
      return new Promise((resolve) => {
        try {
          const tx = db.transaction("kline_archive", "readonly");
          const store = tx.objectStore("kline_archive");
          const req = store.get(key);
          req.onsuccess = () => {
            const row = req.result;
            if (!row) return resolve(null);
            if (ttlMs > 0 && Date.now() - row.updated_at > ttlMs) {
              const delTx = db.transaction("kline_archive", "readwrite");
              delTx.objectStore("kline_archive").delete(key);
              return resolve(null);
            }
            resolve(row.data);
          };
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    },

    setArchive: async (key: string, data: Uint8Array): Promise<void> => {
      const db = this.getDb();
      return new Promise((resolve) => {
        try {
          const tx = db.transaction("kline_archive", "readwrite");
          tx.objectStore("kline_archive").put({
            cache_key: key,
            data,
            updated_at: Date.now(),
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    },

    cleanExpired: async (ttlMs: number): Promise<void> => {
      const db = this.getDb();
      return new Promise((resolve) => {
        try {
          const cutoff = Date.now() - ttlMs;
          const tx = db.transaction("kline_archive", "readwrite");
          const store = tx.objectStore("kline_archive");
          const index = store.index("updated_at");
          const range = IDBKeyRange.upperBound(cutoff);
          const req = index.openCursor(range);
          req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
              cursor.delete();
              cursor.continue();
            }
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    },

    deleteArchive: async (key: string): Promise<void> => {
      const db = this.getDb();
      return new Promise((resolve) => {
        try {
          const tx = db.transaction("kline_archive", "readwrite");
          tx.objectStore("kline_archive").delete(key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    },

    deletePrefix: async (prefix: string): Promise<void> => {
      const db = this.getDb();
      return new Promise((resolve) => {
        try {
          const tx = db.transaction("kline_archive", "readwrite");
          const store = tx.objectStore("kline_archive");
          const range = IDBKeyRange.bound(prefix, prefix + "\uffff");
          store.delete(range);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    },
  };
}
