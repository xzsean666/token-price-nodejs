import axios from "axios";
import type { KlinePoint } from "../domain/klineModels";
import { KlineBinaryCodec } from "./KlineBinaryCodec";
import type { ArchiveProviderAdapter } from "./ArchiveProviderAdapter";
import { BinanceArchiveAdapter } from "./BinanceArchiveAdapter";
import { GateArchiveAdapter } from "./GateArchiveAdapter";
import { TokenPriceError } from "../domain/errors";
import type { PriceStorage } from "../storage/PriceStorage";
import type { HttpTransport } from "../transport/HttpTransport";
import { TaskQueue, globalTaskQueue } from "../services/TaskQueue";

export interface KlineArchiveManagerOptions {
  /**
   * @deprecated Disk cacheDir is removed in favor of unified SQLite/Storage archiving.
   */
  readonly cacheDir?: string | undefined;
  readonly ttlMs?: number | undefined; // Default: 0 (permanent cache, never expires automatically)
  readonly storage?: PriceStorage | null | undefined;
  readonly axiosInstance?: any | undefined;
  readonly transport?: HttpTransport | undefined;
  readonly taskQueue?: TaskQueue | undefined;
}

export class KlineArchiveManager {
  private readonly ttlMs: number;
  private readonly storage: PriceStorage | null;
  private readonly fallbackMemoryCache = new Map<string, Uint8Array>();
  private readonly axiosClient: typeof axios;
  private readonly transport: HttpTransport | null;
  private readonly taskQueue: TaskQueue;
  private readonly adapters = new Map<"binance" | "gate", ArchiveProviderAdapter>([
    ["binance", new BinanceArchiveAdapter()],
    ["gate", new GateArchiveAdapter()],
  ]);

  constructor(options: KlineArchiveManagerOptions = {}) {
    this.ttlMs = options.ttlMs ?? 0; // 0 = permanent cache, never expires automatically
    this.storage = options.storage ?? null;
    this.axiosClient = options.axiosInstance ?? axios;
    this.transport = options.transport ?? null;
    this.taskQueue = options.taskQueue ?? globalTaskQueue;
  }

  /**
   * Retrieves the raw 16-byte fixed-width binary data for a completed calendar month.
   * If cached in storage (SQLite / IndexedDB), reads directly from cache.
   * Otherwise, queues the download/encode through the concurrency queue with deduplication.
   */
  async getMonthlyBinary(
    provider: "binance" | "gate",
    symbol: string,
    interval: string,
    year: number,
    month: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new TokenPriceError({
        code: "UNSUPPORTED_OPERATION",
        message: `Archive provider "${provider}" is not supported.`,
        retryable: false,
        provider,
      });
    }

    const cleanSymbol = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const baseSymbol = cleanSymbol.endsWith("USDT") && cleanSymbol.length > 4 ? cleanSymbol.slice(0, -4) : cleanSymbol;
    const mm = String(month).padStart(2, "0");
    const cacheKey = `${provider}/${baseSymbol}/${interval}/${year}-${mm}`;

    // 1. Fast path: check storage archive cache
    const cachedData = await this.readCache(cacheKey);
    if (cachedData) {
      return cachedData;
    }

    // 2. Slow path: Enqueue download and encode with in-flight deduplication and concurrency control
    return this.taskQueue.enqueue(`archive:${cacheKey}`, async () => {
      // Re-check cache after acquiring execution slot
      const recheck = await this.readCache(cacheKey);
      if (recheck) {
        return recheck;
      }

      if (signal?.aborted) {
        throw new TokenPriceError({
          code: "REQUEST_ABORTED",
          message: "Kline archive download was aborted.",
          retryable: false,
          provider,
        });
      }

      const url = adapter.getMonthlyArchiveUrl(baseSymbol, interval, year, month);
      let rawBuffer: Uint8Array;
      try {
        if (this.transport) {
          const res = await this.transport.request<ArrayBuffer | Uint8Array>({
            method: "GET",
            url,
            responseType: "arraybuffer",
            timeoutMs: 60_000,
            ...(signal === undefined ? {} : { signal }),
          });
          if (res.status !== 200 || !res.body) {
            throw new Error(`HTTP ${res.status}`);
          }
          rawBuffer = res.body instanceof Uint8Array ? res.body : new Uint8Array(res.body);
        } else {
          const res = await this.axiosClient.get(url, {
            responseType: "arraybuffer",
            timeout: 60_000,
            ...(signal === undefined ? {} : { signal }),
          });
          rawBuffer = res.data instanceof Uint8Array ? res.data : new Uint8Array(res.data);
        }
      } catch (error: any) {
        if (signal?.aborted) {
          throw new TokenPriceError({
            code: "REQUEST_ABORTED",
            message: "Kline archive download was aborted.",
            retryable: false,
            provider,
          });
        }
        throw new TokenPriceError({
          code: "PROVIDER_UNAVAILABLE",
          message: `Failed to download kline archive from ${provider} for ${baseSymbol} ${year}-${mm}.`,
          retryable: true,
          provider,
          cause: error,
        });
      }

      // Parse and normalize into points
      const points = await adapter.parseArchive(rawBuffer, interval);

      // Encode to compact 16-byte fixed-length binary
      const binaryData = KlineBinaryCodec.encode(points);

      // Write to storage cache (permanent by default, stored in SQLite sdk_kline_archive_cache / IndexedDB)
      await this.writeCache(cacheKey, binaryData);

      // Clean up any daily fragments for this month now that full month is sealed!
      if (this.storage?.archiveCache.deletePrefix) {
        try {
          await this.storage.archiveCache.deletePrefix(`daily/${provider}/${baseSymbol}/${interval}/${year}-${mm}`);
        } catch {
          // Ignore
        }
      }

      return binaryData;
    });
  }

  /**
   * Retrieves kline points for a completed calendar month.
   * If cached in storage, reads directly from cache without re-downloading.
   */
  async getMonthlyKlines(
    provider: "binance" | "gate",
    symbol: string,
    interval: string,
    year: number,
    month: number,
    startMs?: number,
    endMs?: number,
    signal?: AbortSignal,
  ): Promise<KlinePoint[]> {
    const binaryData = await this.getMonthlyBinary(provider, symbol, interval, year, month, signal);
    return KlineBinaryCodec.decode(binaryData, startMs, endMs);
  }

  /**
   * Directly finds a single KlinePoint near targetMs from the monthly binary archive
   * using O(log N) binary search on the raw binary buffer.
   */
  async getPointAt(
    provider: "binance" | "gate",
    symbol: string,
    interval: string,
    targetMs: number,
    direction: "before" | "after" | "nearest" = "before",
    maxDistanceMs?: number,
    signal?: AbortSignal,
  ): Promise<KlinePoint | null> {
    const d = new Date(targetMs);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const binaryData = await this.getMonthlyBinary(provider, symbol, interval, year, month, signal);
    const point = KlineBinaryCodec.findPointAt(binaryData, targetMs, direction, maxDistanceMs);
    if (point) return point;

    // Month boundary check: if direction is "before" (or "nearest") and target is near the start of the month,
    // look in the previous month's archive.
    if (direction === "before" || direction === "nearest") {
      const monthStartMs = Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
      const distFromStart = targetMs - monthStartMs;
      const effectiveMaxDist = maxDistanceMs ?? 5 * 60 * 1000;
      if (distFromStart >= 0 && distFromStart <= effectiveMaxDist) {
        let prevYear = year;
        let prevMonth = month - 1;
        if (prevMonth < 1) {
          prevMonth = 12;
          prevYear--;
        }
        try {
          const prevBinary = await this.getMonthlyBinary(provider, symbol, interval, prevYear, prevMonth, signal);
          const prevPoint = KlineBinaryCodec.findPointAt(prevBinary, targetMs, "before", maxDistanceMs);
          if (prevPoint) return prevPoint;
        } catch {
          // If previous month archive is not available, ignore
        }
      }
    }

    return null;
  }

  private async readCache(cacheKey: string): Promise<Uint8Array | null> {
    if (this.storage) {
      return this.storage.archiveCache.getArchive(cacheKey, this.ttlMs);
    }
    return this.fallbackMemoryCache.get(cacheKey) ?? null;
  }

  private async writeCache(cacheKey: string, data: Uint8Array): Promise<void> {
    if (this.storage) {
      await this.storage.archiveCache.setArchive(cacheKey, data).catch(() => undefined);
    } else {
      this.fallbackMemoryCache.set(cacheKey, data);
    }
  }

  /**
   * Explicitly cleans up cache records older than TTL from storage.
   * By default does nothing unless a positive TTL is specified.
   */
  async cleanExpiredCache(explicitTtlMs?: number): Promise<void> {
    const ttl = explicitTtlMs ?? this.ttlMs;
    if (ttl <= 0) return; // Do not delete anything if TTL is not positive

    if (this.storage) {
      await this.storage.archiveCache.cleanExpired(ttl).catch(() => undefined);
    }
  }

  /**
   * Explicitly clears all cached archives in storage.
   */
  async clearCache(): Promise<void> {
    if (this.storage) {
      await this.storage.archiveCache.cleanExpired(0).catch(() => undefined);
    }
    this.fallbackMemoryCache.clear();
  }
}
