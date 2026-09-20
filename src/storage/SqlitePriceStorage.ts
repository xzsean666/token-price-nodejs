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

export interface SqliteStorageOptions {
  readonly path?: string | undefined;
  readonly busyTimeoutMs?: number | undefined;
  readonly customDb?: any | undefined;
}

export interface GenericSqlExecutor {
  exec(sql: string): void | Promise<void>;
  get<T = any>(sql: string, params?: any[] | Record<string, any>): T | undefined | Promise<T | undefined>;
  all<T = any>(sql: string, params?: any[] | Record<string, any>): T[] | Promise<T[]>;
  run(sql: string, params?: any[] | Record<string, any>): { changes: number } | Promise<{ changes: number }>;
  transaction?<T>(fn: (tx: any) => Promise<T> | T): Promise<T>;
}

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS sdk_token_support (
  token TEXT NOT NULL,
  provider TEXT NOT NULL,
  supported INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(token, provider)
);
CREATE INDEX IF NOT EXISTS sdk_token_support_token ON sdk_token_support(token);

CREATE TABLE IF NOT EXISTS sdk_price_sync_scopes (
  scope_key TEXT PRIMARY KEY,
  next_from TEXT NOT NULL,
  target_to TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sdk_price_points (
  scope_key TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY(scope_key, timestamp)
);
CREATE INDEX IF NOT EXISTS sdk_price_points_scope_time ON sdk_price_points(scope_key, timestamp);

CREATE TABLE IF NOT EXISTS sdk_kline_archive_cache (
  cache_key TEXT PRIMARY KEY,
  data BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export class SqlitePriceStorage implements PriceStorage {
  readonly driver = "sqlite" as const;
  private readonly path: string;
  private readonly busyTimeoutMs: number;
  private db: any = null;
  private readonly externalExecutor: GenericSqlExecutor | null = null;

  constructor(options: SqliteStorageOptions = {}) {
    this.path = options.path ?? "./data/token-price.db";
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5000;
    if (options.customDb) {
      this.externalExecutor = options.customDb;
    }
  }

  static fromStorageAdapter(adapter: GenericSqlExecutor): SqlitePriceStorage {
    return new SqlitePriceStorage({ customDb: adapter });
  }

  async initialize(): Promise<void> {
    if (this.externalExecutor) {
      try {
        await this.externalExecutor.exec(SQLITE_SCHEMA);
      } catch (err: any) {
        // Table might already exist
      }
      return;
    }

    if (this.db !== null) return;

    try {
      if (this.path !== ":memory:") {
        const { mkdirSync } = await import("node:fs");
        const { dirname, resolve } = await import("node:path");
        mkdirSync(dirname(resolve(this.path)), { recursive: true });
      }

      const sqliteModule = "node:sqlite";
      let sqlite: any;
      try {
        sqlite = await import(/* @vite-ignore */ sqliteModule);
      } catch (importErr) {
        throw new Error(
          `Built-in "node:sqlite" is not available in Node.js ${typeof process !== "undefined" ? process.version : "environment"}. Node.js >= 22.5.0 is required for built-in SQLite, or supply an external database adapter via options.customDb.`,
          { cause: importErr },
        );
      }
      this.db = new sqlite.DatabaseSync(this.path);
      this.db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.trunc(this.busyTimeoutMs))}; PRAGMA foreign_keys=ON;`);
      if (this.path !== ":memory:") {
        try {
          this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
        } catch {
          // Ignore
        }
      }
      this.db.exec(SQLITE_SCHEMA);
    } catch (error) {
      this.db = null;
      throw storageError("Failed to initialize SQLite price storage.", error);
    }
  }

  private getExecutor(): GenericSqlExecutor {
    if (this.externalExecutor) return this.externalExecutor;
    if (!this.db) throw storageError("SQLite price storage is not initialized.");
    return {
      exec: (sql: string) => this.db.exec(sql),
      get: (sql: string, params?: any[]) => {
        const stmt = this.db.prepare(sql);
        return params === undefined ? stmt.get() : stmt.get(...params);
      },
      all: (sql: string, params?: any[]) => {
        const stmt = this.db.prepare(sql);
        return params === undefined ? stmt.all() : stmt.all(...params);
      },
      run: (sql: string, params?: any[]) => {
        const stmt = this.db.prepare(sql);
        const res = params === undefined ? stmt.run() : stmt.run(...params);
        return { changes: Number(res.changes) };
      },
      transaction: async (fn) => {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const res = await fn(this.getExecutor());
          this.db.exec("COMMIT");
          return res;
        } catch (e) {
          try {
            this.db.exec("ROLLBACK");
          } catch {}
          throw e;
        }
      },
    };
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  readonly tokenSupport: TokenSupportStoreInterface = {
    loadAll: async (): Promise<readonly TokenSupportRecord[]> => {
      const exec = this.getExecutor();
      try {
        const rows = await exec.all<{ token: string; provider: string; supported: number; updated_at: string }>(
          "SELECT token, provider, supported, updated_at FROM sdk_token_support",
        );
        return rows.map((r) => ({
          token: r.token,
          provider: r.provider as TokenSupportProvider,
          supported: Number(r.supported) === 1,
          updatedAt: r.updated_at,
        }));
      } catch {
        return [];
      }
    },

    get: async (token: string, provider: TokenSupportProvider): Promise<TokenSupportRecord | null> => {
      const exec = this.getExecutor();
      try {
        const row = await exec.get<{ token: string; provider: string; supported: number; updated_at: string }>(
          "SELECT token, provider, supported, updated_at FROM sdk_token_support WHERE token=? AND provider=?",
          [token.toUpperCase(), provider],
        );
        if (!row) return null;
        return {
          token: row.token,
          provider: row.provider as TokenSupportProvider,
          supported: Number(row.supported) === 1,
          updatedAt: row.updated_at,
        };
      } catch {
        return null;
      }
    },

    set: async (token: string, provider: TokenSupportProvider, supported: boolean): Promise<void> => {
      const exec = this.getExecutor();
      try {
        await exec.run(
          "INSERT OR REPLACE INTO sdk_token_support (token, provider, supported, updated_at) VALUES (?, ?, ?, ?)",
          [token.toUpperCase(), provider, supported ? 1 : 0, new Date().toISOString()],
        );
      } catch {
        // Storage might not be ready
      }
    },

    setBatch: async (records: readonly { token: string; provider: TokenSupportProvider; supported: boolean }[]): Promise<void> => {
      if (records.length === 0) return;
      const exec = this.getExecutor();
      const nowIso = new Date().toISOString();
      const runWork = async (tx: GenericSqlExecutor) => {
        if (this.db && !this.externalExecutor) {
          const stmt = this.db.prepare(
            "INSERT OR REPLACE INTO sdk_token_support (token, provider, supported, updated_at) VALUES (?, ?, ?, ?)",
          );
          for (const r of records) {
            stmt.run(r.token.toUpperCase(), r.provider, r.supported ? 1 : 0, nowIso);
          }
        } else {
          for (const r of records) {
            await tx.run(
              "INSERT OR REPLACE INTO sdk_token_support (token, provider, supported, updated_at) VALUES (?, ?, ?, ?)",
              [r.token.toUpperCase(), r.provider, r.supported ? 1 : 0, nowIso],
            );
          }
        }
      };

      if (exec.transaction) {
        await exec.transaction(runWork);
      } else {
        await runWork(exec);
      }
    },
  };

  readonly priceSync: PriceSyncStoreInterface = {
    getScope: async (scopeKey: string): Promise<SyncScopeRecord | null> => {
      const exec = this.getExecutor();
      const row = await exec.get<SyncScopeRecord>(
        "SELECT scope_key, next_from, target_to, updated_at FROM sdk_price_sync_scopes WHERE scope_key=?",
        [scopeKey],
      );
      return row ?? null;
    },

    setScope: async (scopeKey: string, nextFrom: string, targetTo: string | null): Promise<void> => {
      const exec = this.getExecutor();
      await exec.run(
        "INSERT OR REPLACE INTO sdk_price_sync_scopes (scope_key, next_from, target_to, updated_at) VALUES (?, ?, ?, ?)",
        [scopeKey, nextFrom, targetTo, new Date().toISOString()],
      );
    },

    deleteScope: async (scopeKey: string): Promise<void> => {
      const exec = this.getExecutor();
      await exec.run("DELETE FROM sdk_price_sync_scopes WHERE scope_key=?", [scopeKey]);
    },

    savePoints: async (
      scopeKey: string,
      points: readonly { timestamp: string; payload: unknown }[],
      replaceRange?: { from: string; to: string },
    ): Promise<void> => {
      const exec = this.getExecutor();
      const runWork = async (tx: GenericSqlExecutor) => {
        if (replaceRange) {
          await tx.run(
            "DELETE FROM sdk_price_points WHERE scope_key=? AND timestamp>=? AND timestamp<?",
            [scopeKey, replaceRange.from, replaceRange.to],
          );
        }
        if (this.db && !this.externalExecutor) {
          const stmt = this.db.prepare(
            "INSERT OR REPLACE INTO sdk_price_points (scope_key, timestamp, payload) VALUES (?, ?, ?)",
          );
          for (const pt of points) {
            const payloadStr = typeof pt.payload === "string" ? pt.payload : JSON.stringify(pt.payload);
            stmt.run(scopeKey, pt.timestamp, payloadStr);
          }
        } else {
          for (const pt of points) {
            const payloadStr = typeof pt.payload === "string" ? pt.payload : JSON.stringify(pt.payload);
            await tx.run(
              "INSERT OR REPLACE INTO sdk_price_points (scope_key, timestamp, payload) VALUES (?, ?, ?)",
              [scopeKey, pt.timestamp, payloadStr],
            );
          }
        }
      };

      if (exec.transaction) {
        await exec.transaction(runWork);
      } else {
        await runWork(exec);
      }
    },

    deletePoints: async (scopeKey: string, from?: string, to?: string): Promise<void> => {
      const exec = this.getExecutor();
      if (from !== undefined && to !== undefined) {
        await exec.run("DELETE FROM sdk_price_points WHERE scope_key=? AND timestamp>=? AND timestamp<?", [
          scopeKey,
          from,
          to,
        ]);
      } else {
        await exec.run("DELETE FROM sdk_price_points WHERE scope_key=?", [scopeKey]);
      }
    },

    queryPoint: async (params: QueryPointParams): Promise<QueryPointResult | null> => {
      const exec = this.getExecutor();
      const interval = params.interval ?? "5m";
      const scopeFilter =
        params.scopeKey !== undefined && params.scopeKey !== null
          ? { sql: "scope_key = ?", value: params.scopeKey }
          : params.exchange !== undefined && params.exchange !== null
          ? { sql: "scope_key = ?", value: `${params.tokenKey}:${params.exchange}:${params.market ?? ""}:${params.quote ?? ""}:${interval}` }
          : { sql: "scope_key LIKE ? || '%' ESCAPE '\\'", value: `${escapeSqlLike(params.tokenKey)}:` };

      const requestedIso = params.timestamp;
      const requestedMs = Date.parse(requestedIso);

      const before = await exec.get<PricePointRecord>(
        `SELECT scope_key, timestamp, payload FROM sdk_price_points WHERE ${scopeFilter.sql} AND timestamp <= ? ORDER BY timestamp DESC, scope_key ASC LIMIT 1`,
        [scopeFilter.value, requestedIso],
      );

      const after = await exec.get<PricePointRecord>(
        `SELECT scope_key, timestamp, payload FROM sdk_price_points WHERE ${scopeFilter.sql} AND timestamp >= ? ORDER BY timestamp ASC, scope_key ASC LIMIT 1`,
        [scopeFilter.value, requestedIso],
      );

      let selected: PricePointRecord | undefined;
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
      const exec = this.getExecutor();
      const runWork = async (tx: GenericSqlExecutor) => {
        await tx.run("DELETE FROM sdk_price_points WHERE scope_key=?", [scopeKey]);
        await tx.run("DELETE FROM sdk_price_sync_scopes WHERE scope_key=?", [scopeKey]);
      };
      if (exec.transaction) {
        await exec.transaction(runWork);
      } else {
        await runWork(exec);
      }
    },
  };

  readonly archiveCache: ArchiveCacheStoreInterface = {
    getArchive: async (key: string, ttlMs: number = 0): Promise<Uint8Array | null> => {
      const exec = this.getExecutor();
      try {
        const row = await exec.get<{ data: Buffer | Uint8Array; updated_at: number }>(
          "SELECT data, updated_at FROM sdk_kline_archive_cache WHERE cache_key=?",
          [key],
        );
        if (!row) return null;
        if (ttlMs > 0 && Date.now() - row.updated_at > ttlMs) {
          await exec.run("DELETE FROM sdk_kline_archive_cache WHERE cache_key=?", [key]);
          return null;
        }
        return row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data);
      } catch {
        return null;
      }
    },

    setArchive: async (key: string, data: Uint8Array): Promise<void> => {
      const exec = this.getExecutor();
      try {
        await exec.run(
          "INSERT OR REPLACE INTO sdk_kline_archive_cache (cache_key, data, updated_at) VALUES (?, ?, ?)",
          [key, data, Date.now()],
        );
      } catch {
        // Ignore
      }
    },

    cleanExpired: async (ttlMs: number): Promise<void> => {
      const exec = this.getExecutor();
      const cutoff = Date.now() - ttlMs;
      try {
        await exec.run("DELETE FROM sdk_kline_archive_cache WHERE updated_at <= ?", [cutoff]);
      } catch {
        // Ignore
      }
    },

    deleteArchive: async (key: string): Promise<void> => {
      const exec = this.getExecutor();
      try {
        await exec.run("DELETE FROM sdk_kline_archive_cache WHERE cache_key=?", [key]);
      } catch {
        // Ignore
      }
    },

    deletePrefix: async (prefix: string): Promise<void> => {
      const exec = this.getExecutor();
      try {
        await exec.run("DELETE FROM sdk_kline_archive_cache WHERE cache_key LIKE ? || '%' ESCAPE '\\'", [escapeSqlLike(prefix)]);
      } catch {
        // Ignore
      }
    },
  };
}

function escapeSqlLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
