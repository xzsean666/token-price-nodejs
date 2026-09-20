export interface PriceUpdateRequest {
  readonly token: string;
  readonly exchange: string;
  readonly market?: string | undefined;
  readonly quote?: string | undefined;
  readonly quoteCurrency?: string | undefined;
  readonly interval?: string | undefined;
  readonly fromTimestamp?: string | Date | undefined;
  readonly toTimestamp?: string | Date | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface PriceRecollectRequest extends PriceUpdateRequest {
  readonly dryRun?: boolean | undefined;
  readonly strategy?: "merge" | "overwrite" | undefined;
}

export interface PriceSyncScopeRequest {
  readonly token: string;
  readonly exchange?: string | undefined;
  readonly market?: string | undefined;
  readonly quote?: string | undefined;
  readonly quoteCurrency?: string | undefined;
  readonly interval?: string | undefined;
}

export interface PriceUpdateResult {
  readonly status: "completed";
  readonly scopeKey: string;
  readonly tokenKey: string;
  readonly exchange: string;
  readonly market: string | null;
  readonly quoteCurrency: string | null;
  readonly interval: string;
  readonly fromTimestamp: string;
  readonly toTimestamp: string;
  readonly requestedRange: {
    readonly fromTimestamp: string;
    readonly toTimestamp: string;
  };
  readonly coveredRange: {
    readonly start: string;
    readonly end: string;
  } | null;
  readonly nextFromTimestamp: string;
  readonly recordsSeen: number;
  readonly recordsWritten: number;
  readonly pointsWritten: number;
  readonly hasNext: boolean;
  readonly provider: string;
  readonly runId: string;
}

export interface PricePointQuery {
  readonly token: string;
  readonly timestamp: string | number | Date;
  readonly exchange?: string | undefined;
  readonly market?: string | undefined;
  readonly quote?: string | undefined;
  readonly quoteCurrency?: string | undefined;
  readonly interval?: string | undefined;
  readonly direction?: "before" | "after" | "nearest" | undefined;
  readonly mode?: "before" | "after" | "nearest" | undefined;
  readonly maxDistanceMs?: number | string | bigint | null | undefined;
  readonly autoFetch?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface PriceAtResult {
  readonly tokenKey: string;
  readonly timestamp: string;
  readonly requestedTimestamp: string;
  readonly exchange: string | null;
  readonly market: string | null;
  readonly quoteCurrency: string | null;
  readonly status: "priced" | "missing";
  readonly state: "priced" | "missing";
  readonly price: string | null;
  readonly rawPoint?: unknown;
  readonly priceTimestamp: string | null;
  readonly distanceMs: string | null;
}
