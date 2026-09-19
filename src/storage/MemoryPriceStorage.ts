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

export class MemoryPriceStorage implements PriceStorage {
  readonly driver = "memory" as const;

  private readonly tokenSupportMap = new Map<string, TokenSupportRecord>();
  private readonly scopesMap = new Map<string, SyncScopeRecord>();
  private readonly pointsMap = new Map<string, Map<string, string>>(); // scope_key -> (timestamp -> payloadStr)
  private readonly archiveCacheMap = new Map<string, { data: Uint8Array; updatedAt: number }>();

  async initialize(): Promise<void> {
    // No-op for memory storage
  }

  async close(): Promise<void> {
    this.tokenSupportMap.clear();
    this.scopesMap.clear();
    this.pointsMap.clear();
    this.archiveCacheMap.clear();
  }

  readonly tokenSupport: TokenSupportStoreInterface = {
    loadAll: async (): Promise<readonly TokenSupportRecord[]> => {
      return [...this.tokenSupportMap.values()];
    },

    get: async (token: string, provider: TokenSupportProvider): Promise<TokenSupportRecord | null> => {
      const key = `${token.toUpperCase()}:${provider}`;
      return this.tokenSupportMap.get(key) ?? null;
    },

    set: async (token: string, provider: TokenSupportProvider, supported: boolean): Promise<void> => {
      const key = `${token.toUpperCase()}:${provider}`;
      this.tokenSupportMap.set(key, {
        token: token.toUpperCase(),
        provider,
        supported,
        updatedAt: new Date().toISOString(),
      });
    },
  };

  readonly priceSync: PriceSyncStoreInterface = {
    getScope: async (scopeKey: string): Promise<SyncScopeRecord | null> => {
      return this.scopesMap.get(scopeKey) ?? null;
    },

    setScope: async (scopeKey: string, nextFrom: string, targetTo: string | null): Promise<void> => {
      this.scopesMap.set(scopeKey, {
        scope_key: scopeKey,
        next_from: nextFrom,
        target_to: targetTo,
        updated_at: new Date().toISOString(),
      });
    },

    deleteScope: async (scopeKey: string): Promise<void> => {
      this.scopesMap.delete(scopeKey);
    },

    savePoints: async (
      scopeKey: string,
      points: readonly { timestamp: string; payload: unknown }[],
      replaceRange?: { from: string; to: string },
    ): Promise<void> => {
      let map = this.pointsMap.get(scopeKey);
      if (!map) {
        map = new Map<string, string>();
        this.pointsMap.set(scopeKey, map);
      }

      if (replaceRange) {
        for (const ts of [...map.keys()]) {
          if (ts >= replaceRange.from && ts < replaceRange.to) {
            map.delete(ts);
          }
        }
      }

      for (const pt of points) {
        const payloadStr = typeof pt.payload === "string" ? pt.payload : JSON.stringify(pt.payload);
        map.set(pt.timestamp, payloadStr);
      }
    },

    deletePoints: async (scopeKey: string, from?: string, to?: string): Promise<void> => {
      const map = this.pointsMap.get(scopeKey);
      if (!map) return;

      if (from !== undefined && to !== undefined) {
        for (const ts of [...map.keys()]) {
          if (ts >= from && ts < to) {
            map.delete(ts);
          }
        }
      } else {
        this.pointsMap.delete(scopeKey);
      }
    },

    queryPoint: async (params: QueryPointParams): Promise<QueryPointResult | null> => {
      const targetScope = params.scopeKey ?? (params.exchange ? `${params.tokenKey}:${params.exchange}:${params.market ?? ""}:${params.quote ?? ""}:5m` : null);
      const requestedIso = params.timestamp;
      const requestedMs = Date.parse(requestedIso);

      const candidatePoints: Array<{ scopeKey: string; timestamp: string; payload: string }> = [];

      for (const [scopeKey, map] of this.pointsMap.entries()) {
        if (targetScope) {
          if (scopeKey !== targetScope) continue;
        } else {
          if (!scopeKey.startsWith(`${params.tokenKey}:`)) continue;
        }

        for (const [timestamp, payload] of map.entries()) {
          candidatePoints.push({ scopeKey, timestamp, payload });
        }
      }

      if (candidatePoints.length === 0) return null;

      // Sort candidate points by timestamp ascending, then scopeKey
      candidatePoints.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.scopeKey.localeCompare(b.scopeKey));

      let before: { scopeKey: string; timestamp: string; payload: string } | undefined;
      let after: { scopeKey: string; timestamp: string; payload: string } | undefined;

      for (const pt of candidatePoints) {
        if (pt.timestamp <= requestedIso) {
          before = pt;
        }
        if (pt.timestamp >= requestedIso && !after) {
          after = pt;
        }
      }

      let selected: { scopeKey: string; timestamp: string; payload: string } | undefined;
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
        scopeKey: selected.scopeKey,
        timestamp: selected.timestamp,
        payload,
      };
    },

    resetSync: async (scopeKey: string): Promise<void> => {
      this.pointsMap.delete(scopeKey);
      this.scopesMap.delete(scopeKey);
    },
  };

  readonly archiveCache: ArchiveCacheStoreInterface = {
    getArchive: async (key: string, ttlMs: number = 86_400_000): Promise<Uint8Array | null> => {
      const entry = this.archiveCacheMap.get(key);
      if (!entry) return null;
      if (Date.now() - entry.updatedAt > ttlMs) {
        this.archiveCacheMap.delete(key);
        return null;
      }
      return entry.data;
    },

    setArchive: async (key: string, data: Uint8Array): Promise<void> => {
      this.archiveCacheMap.set(key, { data, updatedAt: Date.now() });
    },

    cleanExpired: async (ttlMs: number): Promise<void> => {
      const cutoff = Date.now() - ttlMs;
      for (const [k, v] of this.archiveCacheMap.entries()) {
        if (v.updatedAt <= cutoff) {
          this.archiveCacheMap.delete(k);
        }
      }
    },
  };
}
