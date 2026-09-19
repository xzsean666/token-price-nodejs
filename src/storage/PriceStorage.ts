import type { TokenSupportProvider, TokenSupportRecord } from "../domain/tokenSupportModels";

export interface SyncScopeRecord {
  readonly scope_key: string;
  readonly next_from: string;
  readonly target_to: string | null;
  readonly updated_at: string;
}

export interface PricePointRecord {
  readonly scope_key: string;
  readonly timestamp: string;
  readonly payload: string; // JSON string or raw point string
}

export interface QueryPointParams {
  readonly tokenKey: string;
  readonly exchange?: string | null | undefined;
  readonly market?: string | null | undefined;
  readonly quote?: string | null | undefined;
  readonly scopeKey?: string | null | undefined;
  readonly timestamp: string; // ISO string
  readonly direction: "before" | "after" | "nearest";
  readonly maxDistanceMs?: number | undefined;
}

export interface QueryPointResult {
  readonly scopeKey: string;
  readonly timestamp: string;
  readonly payload: unknown;
}

export interface TokenSupportStoreInterface {
  loadAll(): Promise<readonly TokenSupportRecord[]>;
  get(token: string, provider: TokenSupportProvider): Promise<TokenSupportRecord | null>;
  set(token: string, provider: TokenSupportProvider, supported: boolean): Promise<void> | void;
}

export interface PriceSyncStoreInterface {
  getScope(scopeKey: string): Promise<SyncScopeRecord | null>;
  setScope(scopeKey: string, nextFrom: string, targetTo: string | null): Promise<void>;
  deleteScope(scopeKey: string): Promise<void>;
  savePoints(scopeKey: string, points: readonly { timestamp: string; payload: unknown }[], replaceRange?: { from: string; to: string }): Promise<void>;
  deletePoints(scopeKey: string, from?: string, to?: string): Promise<void>;
  queryPoint(params: QueryPointParams): Promise<QueryPointResult | null>;
  resetSync(scopeKey: string): Promise<void>;
}

export interface ArchiveCacheStoreInterface {
  getArchive(key: string, ttlMs?: number): Promise<Uint8Array | null>;
  setArchive(key: string, data: Uint8Array): Promise<void>;
  cleanExpired(ttlMs: number): Promise<void>;
}

export interface PriceStorage {
  readonly driver: "sqlite" | "indexeddb" | "memory";
  readonly tokenSupport: TokenSupportStoreInterface;
  readonly priceSync: PriceSyncStoreInterface;
  readonly archiveCache: ArchiveCacheStoreInterface;
  initialize(): Promise<void>;
  close(): Promise<void>;
}
