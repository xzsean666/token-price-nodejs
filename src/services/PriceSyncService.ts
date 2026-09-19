import { TokenPriceError } from "../domain/errors";
import type {
  PriceUpdateRequest,
  PriceUpdateResult,
  PriceRecollectRequest,
  PricePointQuery,
  PriceAtResult,
  PriceSyncScopeRequest,
} from "../domain/priceSyncModels";
import type { BinanceAdapter } from "../providers/binance/BinanceAdapter";
import type { TokenPriceProviderAdapter } from "../providers/TokenPriceProviderAdapter";
import { normalizeTokenPriceHistoryRequest } from "../domain/priceOperations";
import type { PriceStorage, PriceSyncStoreInterface } from "../storage/PriceStorage";
import { SqlitePriceStorage, type GenericSqlExecutor } from "../storage/SqlitePriceStorage";

interface PriceRows {
  scope: string;
  tokenKey: string;
  exchange: string;
  market: string | null;
  quote: string | null;
  interval: string;
  rows: { timestamp: string; payload: unknown }[];
  next: string;
  from: string;
  to: string;
}

interface ResolvedRange {
  from: string;
  to: string;
  scope: string;
  tokenKey: string;
  exchange: string;
  market: string | null;
  quote: string | null;
  interval: string;
}

export class PriceSyncService {
  private readonly store: PriceSyncStoreInterface;

  constructor(
    storage: PriceStorage | PriceSyncStoreInterface | GenericSqlExecutor,
    private readonly binance: BinanceAdapter,
    private readonly aliases: Readonly<Record<string, string>> = {},
    private readonly dailyAdapters: ReadonlyMap<string, TokenPriceProviderAdapter> = new Map(),
  ) {
    if ("priceSync" in storage && typeof storage.priceSync === "object") {
      this.store = storage.priceSync;
    } else if ("getScope" in storage && typeof storage.getScope === "function") {
      this.store = storage as PriceSyncStoreInterface;
    } else {
      const sqliteStorage = SqlitePriceStorage.fromStorageAdapter(storage as GenericSqlExecutor);
      this.store = sqliteStorage.priceSync;
    }
  }

  async update(input: PriceUpdateRequest): Promise<PriceUpdateResult> {
    const range = await this.resolveRange(input, false);
    const planned = await this.fetch(input, range);
    await this.write(planned, false);
    return this.result(planned, planned.rows.length);
  }

  async recollect(input: PriceRecollectRequest): Promise<PriceUpdateResult & { operation: "recollect"; dryRun: boolean }> {
    const range = await this.resolveRange(input, true);
    const planned = await this.fetch(input, range);
    if (!input.dryRun) await this.write(planned, input.strategy !== "merge");
    return { ...this.result(planned, input.dryRun ? 0 : planned.rows.length), operation: "recollect", dryRun: input.dryRun ?? false };
  }

  async getSyncStatus(input: Pick<PriceUpdateRequest, "token" | "exchange" | "market" | "quote" | "quoteCurrency" | "interval">) {
    const scope = this.scope(input);
    const row = await this.store.getScope(scope);
    return row ?? { scope_key: scope, next_from: null, target_to: null, updated_at: null };
  }

  async resetPriceSync(input: PriceSyncScopeRequest): Promise<void> {
    const scope = this.scope(input);
    await this.store.resetSync(scope);
  }

  async resetSync(input: PriceSyncScopeRequest): Promise<void> {
    return this.resetPriceSync(input);
  }

  async getPriceAt(input: PricePointQuery): Promise<PriceAtResult> {
    const requested = parseTimestamp(input.timestamp);
    const scope = this.scope(input);
    const direction = input.direction ?? input.mode ?? "nearest";
    const tokenKey = this.tokenKey(input.token);

    const point = await this.store.queryPoint({
      tokenKey,
      scopeKey: input.exchange === undefined ? null : scope,
      exchange: input.exchange?.toLowerCase(),
      market: input.market?.toUpperCase(),
      quote: input.quoteCurrency ?? input.quote,
      timestamp: requested.iso,
      direction,
      maxDistanceMs: input.maxDistanceMs === undefined ? undefined : Number(input.maxDistanceMs),
    });

    const selected = point === null ? null : parseScope(point.scopeKey);
    const base = {
      tokenKey,
      timestamp: requested.iso,
      requestedTimestamp: requested.iso,
      exchange: input.exchange?.toLowerCase() ?? selected?.exchange ?? null,
      market: input.market?.toUpperCase() ?? selected?.market ?? null,
      quoteCurrency: input.quoteCurrency ?? input.quote ?? selected?.quote ?? null,
    };

    if (!point) return { ...base, status: "missing", state: "missing", price: null, priceTimestamp: null, distanceMs: null };

    const distance = Math.abs(parseTimestamp(point.timestamp).ms - requested.ms);
    if (input.maxDistanceMs !== undefined && BigInt(distance) > BigInt(input.maxDistanceMs)) {
      return { ...base, status: "missing", state: "missing", price: null, priceTimestamp: null, distanceMs: null };
    }

    const rawPoint: any = point.payload;
    const price = typeof rawPoint === "string" ? rawPoint : rawPoint?.priceUsd ?? rawPoint?.price ?? rawPoint?.close;
    if (typeof price !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(price)) {
      return { ...base, status: "missing", state: "missing", price: null, priceTimestamp: null, distanceMs: null };
    }

    return { ...base, status: "priced", state: "priced", price, rawPoint, priceTimestamp: point.timestamp, distanceMs: String(distance) };
  }

  async getPricesAt(inputs: readonly PricePointQuery[]): Promise<readonly PriceAtResult[]> {
    return Promise.all(inputs.map((input) => this.getPriceAt(input)));
  }

  private async resolveRange(input: PriceUpdateRequest, explicitRange: boolean): Promise<ResolvedRange> {
    const scope = this.scope(input);
    const existing = await this.store.getScope(scope);
    const suppliedFrom = input.fromTimestamp === undefined ? null : parseTimestamp(input.fromTimestamp).iso;
    const from = suppliedFrom ?? existing?.next_from ?? null;
    if (from === null) throw new TokenPriceError({ code: "PRICE_RANGE_INVALID", message: "A starting timestamp is required for a new price scope.", retryable: false });
    if (suppliedFrom !== null && existing !== null && suppliedFrom !== existing.next_from && !explicitRange) {
      throw new TokenPriceError({ code: "SYNC_SCOPE_CONFLICT", message: "Explicit price start conflicts with persisted scope.", retryable: false });
    }
    const to = parseTimestamp(input.toTimestamp ?? new Date()).iso;
    if (from >= to) throw new TokenPriceError({ code: "PRICE_RANGE_INVALID", message: "Price range must be non-empty and ordered.", retryable: false });
    const exchange = input.exchange.trim().toLowerCase();
    const market = input.market?.trim().toUpperCase() ?? null;
    if (market === null) throw new TokenPriceError({ code: "TOKEN_AMBIGUOUS", message: "A market is required when a token has multiple price markets.", retryable: false, provider: exchange });
    return { from, to, scope, tokenKey: this.tokenKey(input.token), exchange, market, quote: input.quoteCurrency ?? input.quote ?? null, interval: input.interval ?? "5m" };
  }

  private async fetch(input: PriceUpdateRequest, range: ResolvedRange): Promise<PriceRows> {
    const points =
      range.exchange === "binance"
        ? await this.binance.getFiveMinuteKlines(
            range.market!,
            parseTimestamp(range.from).ms,
            parseTimestamp(range.to).ms,
            { proxy: null, timeoutMs: 30_000, nowMs: Date.now(), correlationId: "price-sync", ...(input.signal === undefined ? {} : { signal: input.signal }) },
            range.interval as any,
          )
        : await this.fetchDaily(input, range);

    const rows = points.map((point: any) => ({ timestamp: new Date(point.timestamp).toISOString(), payload: point }));
    if (rows.length === 0) {
      throw new TokenPriceError({ code: "PROVIDER_STALLED", message: "Price provider returned no verifiable points for the requested range.", retryable: true, provider: range.exchange });
    }
    const next = new Date(parseTimestamp(rows.at(-1)!.timestamp).ms + this.intervalMs(range.interval)).toISOString();
    return { ...range, rows, next: next > range.to ? range.to : next };
  }

  private async fetchDaily(input: PriceUpdateRequest, range: ResolvedRange): Promise<readonly { timestamp: number; price: string }[]> {
    if (range.interval !== "1d") throw new TokenPriceError({ code: "PRICE_DATA_UNAVAILABLE", message: "Configured non-Binance price adapters support daily candles only.", retryable: false, provider: range.exchange });
    const adapter = this.dailyAdapters.get(range.exchange);
    if (adapter === undefined) throw new TokenPriceError({ code: "PRICE_DATA_UNAVAILABLE", message: "The requested price exchange is not configured.", retryable: false, provider: range.exchange });
    const startDate = new Date(parseTimestamp(range.from).ms).toISOString().slice(0, 10);
    const endDate = new Date(parseTimestamp(range.to).ms - 1).toISOString().slice(0, 10);
    const request = normalizeTokenPriceHistoryRequest({ token: input.token, range: { kind: "between", startDate, endDate }, ...(input.signal === undefined ? {} : { signal: input.signal }) }, { aliases: this.aliases });
    const result = await adapter.getPriceHistory(request, { proxy: null, timeoutMs: 30_000, nowMs: Date.now(), correlationId: "price-sync", ...(input.signal === undefined ? {} : { signal: input.signal }) });
    return result.points.filter((point) => { const timestamp = Date.parse(point.timestamp); return timestamp >= parseTimestamp(range.from).ms && timestamp < parseTimestamp(range.to).ms; }).map((point) => ({ timestamp: Date.parse(point.timestamp), price: point.price }));
  }

  private async write(planned: PriceRows, replace: boolean): Promise<void> {
    await this.store.savePoints(
      planned.scope,
      planned.rows,
      replace ? { from: planned.from, to: planned.to } : undefined,
    );
    await this.store.setScope(planned.scope, planned.next, planned.to);
  }

  private result(planned: PriceRows, count: number): PriceUpdateResult {
    const hasNext = planned.next < planned.to;
    return {
      status: "completed",
      scopeKey: planned.scope,
      tokenKey: planned.tokenKey,
      exchange: planned.exchange,
      market: planned.market,
      quoteCurrency: planned.quote,
      interval: planned.interval,
      fromTimestamp: planned.from,
      toTimestamp: planned.to,
      requestedRange: { fromTimestamp: planned.from, toTimestamp: planned.to },
      coveredRange: planned.rows.length ? { start: planned.rows[0]!.timestamp, end: planned.rows.at(-1)!.timestamp } : null,
      nextFromTimestamp: planned.next,
      recordsSeen: planned.rows.length,
      recordsWritten: count,
      pointsWritten: count,
      hasNext,
      provider: planned.exchange,
      runId: defaultUuid(),
    };
  }

  private scope(input: {
    token: string;
    exchange?: string | null | undefined;
    market?: string | null | undefined;
    quote?: string | null | undefined;
    quoteCurrency?: string | null | undefined;
    interval?: string | null | undefined;
  }): string {
    return [
      this.tokenKey(input.token),
      input.exchange?.trim().toLowerCase() ?? "",
      input.market?.trim().toUpperCase() ?? "",
      input.quoteCurrency ?? input.quote ?? "",
      input.interval ?? "5m",
    ].join(":");
  }

  private tokenKey(token: string): string {
    const normalized = normalizeToken(token);
    return (this.aliases[normalized] ?? normalized).trim().toLowerCase();
  }

  private intervalMs(interval: string): number {
    const m = interval.match(/^(\d+)([smhd])$/);
    if (!m) throw new TokenPriceError({ code: "PRICE_RANGE_INVALID", message: "Unsupported price interval.", retryable: false });
    const n = Number(m[1]);
    return n * (m[2] === "s" ? 1_000 : m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000);
  }
}

function normalizeToken(token: string): string {
  const normalized = token.trim().toLowerCase();
  if (normalized === "") throw new TokenPriceError({ code: "TOKEN_NOT_FOUND", message: "Token is required.", retryable: false });
  return normalized;
}

function parseTimestamp(value: string | Date): { ms: number; iso: string } {
  const ms = value instanceof Date ? value.getTime() : /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isSafeInteger(ms) || !Number.isFinite(ms)) throw new TokenPriceError({ code: "PRICE_RANGE_INVALID", message: "Invalid price timestamp.", retryable: false });
  return { ms, iso: new Date(ms).toISOString() };
}

function parseScope(scope: string): { exchange: string | null; market: string | null; quote: string | null } | null {
  const parts = scope.split(":");
  if (parts.length < 5) return null;
  return { exchange: parts[1] || null, market: parts[2] || null, quote: parts[3] || null };
}

function defaultUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
