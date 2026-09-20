import type { KlinePoint, KlineResult, NormalizedKlineRequest } from "../domain/klineModels";
import type { TokenSupportService } from "./TokenSupportService";
import type { KlineArchiveManager } from "../archive/KlineArchiveManager";
import { KlineBinaryCodec } from "../archive/KlineBinaryCodec";
import type { BinanceAdapter } from "../providers/binance/BinanceAdapter";
import type { GateAdapter } from "../providers/gate/GateAdapter";
import { TokenPriceError } from "../domain/errors";
import { fetchBinanceFiveMinuteKlines } from "../providers/binance/binanceFiveMinute";
import type { HttpTransport } from "../transport/HttpTransport";
import { AxiosHttpTransport } from "../transport/AxiosHttpTransport";
import type { PriceStorage } from "../storage/PriceStorage";
import { TaskQueue, globalTaskQueue } from "./TaskQueue";

export interface UnifiedKlineServiceOptions {
  readonly transport?: HttpTransport | undefined;
  readonly gateBaseUrl?: string | undefined;
  readonly binanceBaseUrl?: string | undefined;
  readonly taskQueue?: TaskQueue | undefined;
  readonly storage?: PriceStorage | undefined;
}

export class UnifiedKlineService {
  private readonly transport: HttpTransport;
  private readonly gateBaseUrl: string;
  private readonly binanceBaseUrl: string;
  private readonly taskQueue: TaskQueue;
  private readonly storage: PriceStorage | null;
  private readonly recentBinaryCache = new Map<string, { binary: Uint8Array; expiresAt: number }>();

  constructor(
    private readonly tokenSupport: TokenSupportService,
    private readonly archiveManager: KlineArchiveManager,
    private readonly binanceAdapter: any = null,
    private readonly gateAdapter: any = null,
    options: UnifiedKlineServiceOptions = {},
  ) {
    this.transport = options.transport ?? new AxiosHttpTransport();
    this.gateBaseUrl = (options.gateBaseUrl ?? "https://api.gateio.ws").replace(/\/$/, "");
    this.binanceBaseUrl = (options.binanceBaseUrl ?? "https://api.binance.com").replace(/\/$/, "");
    this.taskQueue = options.taskQueue ?? globalTaskQueue;
    this.storage = options.storage ?? null;
  }

  /**
   * Fetches kline data prioritizing Binance first, then Gate.
   * Data older than 1 natural month is fetched via archive packages (.bin cached).
   * Data within the current natural month is fetched via REST API.
   */
  async getKlines(request: NormalizedKlineRequest): Promise<KlineResult> {
    const provider = await this.resolveProvider(request.baseSymbol, request.signal);
    const symbol = provider === "binance" ? `${request.baseSymbol.replace(/_/g, "")}USDT` : `${request.baseSymbol}_USDT`;

    const points = await this.fetchKlinesForProvider(provider, request.baseSymbol, symbol, request);

    return Object.freeze({
      provider,
      symbol,
      quoteAsset: "USDT",
      interval: request.interval,
      start: new Date(request.startMs).toISOString(),
      end: new Date(request.endMs).toISOString(),
      points: Object.freeze(points),
    });
  }

  async getKlinesPrices(request: NormalizedKlineRequest): Promise<readonly KlinePoint[]> {
    const result = await this.getKlines(request);
    return result.points;
  }

  /**
   * Directly extracts a single price point near targetMs looking back from formatted Kline data.
   * If targetMs is in a historical natural month, queries KlineArchiveManager via O(log N) binary search on .bin buffer.
   * If in the current month, fetches recent Klines, encodes to binary, and performs binary search.
   */
  async getPointAt(
    baseSymbol: string,
    interval: string = "5m",
    targetMs: number,
    direction: "before" | "after" | "nearest" = "before",
    maxDistanceMs?: number | undefined,
    preferredExchange?: string | null | undefined,
    signal?: AbortSignal,
  ): Promise<{ point: KlinePoint | null; provider: "binance" | "gate" }> {
    let provider: "binance" | "gate";
    const lower = preferredExchange?.toLowerCase();
    if (lower === "binance" || lower === "gate") {
      provider = lower;
    } else {
      try {
        provider = await this.resolveProvider(baseSymbol, signal);
      } catch {
        provider = "binance";
      }
    }
    const now = new Date();
    const currentMonthStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0);

    if (targetMs < currentMonthStartMs) {
      try {
        const point = await this.archiveManager.getPointAt(
          provider,
          baseSymbol,
          interval,
          targetMs,
          direction,
          maxDistanceMs,
          signal,
        );
        if (point) {
          return { point, provider };
        }
      } catch (err) {
        // If targetMs is within recent 30 days, the monthly archive might not yet be published
        // by the exchange (e.g. early days of a new month). Fall back to REST API below.
        const thirtyDaysAgo = Date.now() - 30 * 24 * 3600 * 1000;
        if (targetMs < thirtyDaysAgo) {
          throw err;
        }
      }
    }

    // Recent range in current natural month (or recent month fallback if archive is not yet published)
    const cleanSymbol = baseSymbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const marketSymbol = provider === "binance" ? `${cleanSymbol}USDT` : `${cleanSymbol}_USDT`;

    const ONE_DAY_MS = 24 * 3600 * 1000;
    const dayStartMs = Math.floor(targetMs / ONE_DAY_MS) * ONE_DAY_MS;
    const isPastDay = dayStartMs + ONE_DAY_MS <= Date.now();
    const dayDate = new Date(dayStartMs).toISOString().slice(0, 10);
    const dailyKey = `daily/${provider}/${cleanSymbol}/${interval}/${dayDate}`;
    const queueKey = `recent:${provider}:${cleanSymbol}:${interval}:${dayStartMs}`;

    // 1. Fast path: check in-memory recent binary cache
    let binary: Uint8Array | null = null;
    const cached = this.recentBinaryCache.get(queueKey);
    if (cached && cached.expiresAt > Date.now()) {
      binary = cached.binary;
    }

    // 2. Storage path: check persistent daily archive in storage (SQLite / IndexedDB)
    if (!binary && this.storage) {
      try {
        const stored = await this.storage.archiveCache.getArchive(dailyKey);
        if (stored) {
          binary = stored;
          this.recentBinaryCache.set(queueKey, {
            binary: stored,
            expiresAt: Date.now() + (isPastDay ? 3600_000 : 60_000),
          });
        }
      } catch {
        // Ignore
      }
    }

    if (!binary) {
      binary = await this.taskQueue.enqueue(queueKey, async () => {
        // Re-check after acquiring lock/slot
        const recheck = this.recentBinaryCache.get(queueKey);
        if (recheck && recheck.expiresAt > Date.now()) {
          return recheck.binary;
        }

        if (this.storage) {
          try {
            const recheckStored = await this.storage.archiveCache.getArchive(dailyKey);
            if (recheckStored) {
              this.recentBinaryCache.set(queueKey, {
                binary: recheckStored,
                expiresAt: Date.now() + (isPastDay ? 3600_000 : 60_000),
              });
              return recheckStored;
            }
          } catch {
            // Ignore
          }
        }

        const startMs = dayStartMs;
        const endMs = Math.min(Date.now(), dayStartMs + ONE_DAY_MS);

        const recentPoints =
          provider === "binance"
            ? await this.fetchRecentBinance(marketSymbol, interval as any, startMs, endMs, signal)
            : await this.fetchRecentGate(marketSymbol, interval, startMs, endMs, signal);

        const encoded = KlineBinaryCodec.encode(recentPoints);

        // If this day is completed (past day), persist to SQLite daily archive cache!
        if (isPastDay && this.storage) {
          try {
            await this.storage.archiveCache.setArchive(dailyKey, encoded);
          } catch {
            // Ignore storage errors
          }
        }

        // TTL: 60s for today, 1 hour for past days of current month
        const ttlMs = isPastDay ? 3600_000 : 60_000;
        this.recentBinaryCache.set(queueKey, {
          binary: encoded,
          expiresAt: Date.now() + ttlMs,
        });

        // Keep at most 200 day-buffers in memory (~1 MB total)
        if (this.recentBinaryCache.size > 200) {
          const firstKey = this.recentBinaryCache.keys().next().value;
          if (firstKey) this.recentBinaryCache.delete(firstKey);
        }

        return encoded;
      });
    }

    let point = KlineBinaryCodec.findPointAt(binary, targetMs, direction, maxDistanceMs);

    // If not found in current day and target is near boundary, check previous boundary
    if (!point && (direction === "before" || direction === "nearest")) {
      const distFromStart = targetMs - currentMonthStartMs;
      const effectiveMaxDist = maxDistanceMs ?? 5 * 60 * 1000;
      if (distFromStart >= 0 && distFromStart <= effectiveMaxDist) {
        try {
          point = await this.archiveManager.getPointAt(
            provider,
            baseSymbol,
            interval,
            targetMs,
            "before",
            maxDistanceMs,
            signal,
          );
        } catch {
          // Ignore
        }
      } else {
        const distFromDayStart = targetMs - dayStartMs;
        if (distFromDayStart >= 0 && distFromDayStart <= effectiveMaxDist && dayStartMs > currentMonthStartMs) {
          try {
            const prevRes = await this.getPointAt(
              baseSymbol,
              interval,
              dayStartMs - 1,
              "before",
              maxDistanceMs,
              provider,
              signal,
            );
            if (prevRes.point) {
              point = prevRes.point;
            }
          } catch {
            // Ignore
          }
        }
      }
    }

    return { point, provider };
  }

  /**
   * Resolves provider according to priority: Binance first, then Gate.
   */
  private async resolveProvider(baseSymbol: string, signal?: AbortSignal): Promise<"binance" | "gate"> {
    const binanceSupported = await this.tokenSupport.isTokenSupported(baseSymbol, "binance", signal);
    if (binanceSupported) return "binance";

    const gateSupported = await this.tokenSupport.isTokenSupported(baseSymbol, "gate", signal);
    if (gateSupported) return "gate";

    throw new TokenPriceError({
      code: "TOKEN_NOT_FOUND",
      message: `Token "${baseSymbol}" is not supported by Binance or Gate.`,
      retryable: false,
    });
  }

  private async fetchKlinesForProvider(
    provider: "binance" | "gate",
    baseSymbol: string,
    marketSymbol: string,
    request: NormalizedKlineRequest,
  ): Promise<KlinePoint[]> {
    const now = new Date();
    // Start of the current natural month in UTC
    const currentMonthStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0);

    const pointsMap = new Map<number, KlinePoint>();

    // 1. Archive portion: any range before the current natural month
    if (request.startMs < currentMonthStartMs) {
      const archiveEndMs = Math.min(request.endMs, currentMonthStartMs);
      const months = getOverlappingCalendarMonths(request.startMs, archiveEndMs);

      for (const [year, month] of months) {
        if (request.signal?.aborted) break;
        try {
          const monthPoints = await this.archiveManager.getMonthlyKlines(
            provider,
            baseSymbol,
            request.interval,
            year,
            month,
            request.startMs,
            archiveEndMs,
            request.signal,
          );
          for (const p of monthPoints) {
            pointsMap.set(p.timestamp, p);
          }
        } catch (err) {
          const thirtyDaysAgo = Date.now() - 30 * 24 * 3600 * 1000;
          if (archiveEndMs >= thirtyDaysAgo) {
            const fallbackStart = Math.max(request.startMs, thirtyDaysAgo);
            const fallbackPoints =
              provider === "binance"
                ? await this.fetchRecentBinance(marketSymbol, request.interval, fallbackStart, archiveEndMs, request.signal)
                : await this.fetchRecentGate(marketSymbol, request.interval, fallbackStart, archiveEndMs, request.signal);
            for (const p of fallbackPoints) {
              pointsMap.set(p.timestamp, p);
            }
          } else {
            throw err;
          }
        }
      }
    }

    // 2. Recent REST API portion: any range in the current natural month
    if (request.endMs > currentMonthStartMs) {
      const recentStartMs = Math.max(request.startMs, currentMonthStartMs);
      const queueKey = `klines:${provider}:${marketSymbol}:${request.interval}:${recentStartMs}:${request.endMs}`;
      const recentPoints = await this.taskQueue.enqueue(queueKey, async () => {
        return provider === "binance"
          ? await this.fetchRecentBinance(marketSymbol, request.interval, recentStartMs, request.endMs, request.signal)
          : await this.fetchRecentGate(marketSymbol, request.interval, recentStartMs, request.endMs, request.signal);
      });

      for (const p of recentPoints) {
        pointsMap.set(p.timestamp, p);
      }

      // Persist completed past days into SQLite daily archive
      if (this.storage && recentPoints.length > 0) {
        const ONE_DAY_MS = 24 * 3600 * 1000;
        const nowMs = Date.now();
        const cleanSymbol = baseSymbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
        const dayBuckets = new Map<string, KlinePoint[]>();

        for (const p of recentPoints) {
          const dStart = Math.floor(p.timestamp / ONE_DAY_MS) * ONE_DAY_MS;
          if (dStart + ONE_DAY_MS <= nowMs) {
            const dayDate = new Date(dStart).toISOString().slice(0, 10);
            const list = dayBuckets.get(dayDate);
            if (list) {
              list.push(p);
            } else {
              dayBuckets.set(dayDate, [p]);
            }
          }
        }

        for (const [dayDate, pts] of dayBuckets.entries()) {
          const dailyKey = `daily/${provider}/${cleanSymbol}/${request.interval}/${dayDate}`;
          const encoded = KlineBinaryCodec.encode(pts);
          this.storage.archiveCache.setArchive(dailyKey, encoded).catch(() => {});
        }
      }
    }

    // Sort ascending and filter strictly within [startMs, endMs)
    return [...pointsMap.values()]
      .filter((p) => p.timestamp >= request.startMs && p.timestamp < request.endMs)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  private async fetchRecentBinance(
    symbol: string,
    interval: import("../domain/binanceKlineModels").BinanceKlineInterval,
    startMs: number,
    endMs: number,
    signal?: AbortSignal,
  ): Promise<KlinePoint[]> {
    const attemptContext = {
      proxy: null,
      timeoutMs: 30_000,
      nowMs: Date.now(),
      correlationId: "unified-kline-binance",
      ...(signal === undefined ? {} : { signal }),
    };
    const points = await fetchBinanceFiveMinuteKlines(
      this.transport,
      this.binanceBaseUrl,
      symbol,
      interval,
      startMs,
      endMs,
      attemptContext,
    );
    return [...points];
  }

  private async fetchRecentGate(
    pair: string,
    interval: string,
    startMs: number,
    endMs: number,
    signal?: AbortSignal,
  ): Promise<KlinePoint[]> {
    const chunkMs = (interval === "1h" ? 900 * 60 * 60 : 900 * 5 * 60) * 1000;
    const chunks: Array<{ from: number; to: number }> = [];
    for (let from = startMs; from < endMs; from += chunkMs) {
      chunks.push({ from, to: Math.min(endMs, from + chunkMs) });
    }

    const points: KlinePoint[] = [];
    const priceIndex = interval === "1h" ? 5 : 2;

    for (const chunk of chunks) {
      if (signal?.aborted) break;
      const res = await this.transport.request({
        method: "GET",
        url: `${this.gateBaseUrl}/api/v4/spot/candlesticks`,
        params: {
          currency_pair: pair,
          interval,
          from: Math.floor(chunk.from / 1000),
          to: Math.floor(chunk.to / 1000),
          limit: 1000,
        },
        timeoutMs: 30_000,
        ...(signal === undefined ? {} : { signal }),
      });

      if (res.status === 200 && Array.isArray(res.body)) {
        for (const row of res.body) {
          if (Array.isArray(row) && row.length >= 6) {
            const ts = Number(row[0]) * 1000;
            const price = String(row[priceIndex]);
            if (Number.isFinite(ts) && Number(price) > 0) {
              points.push({ timestamp: ts, priceUsd: price });
            }
          }
        }
      }
    }

    return points;
  }
}

/**
 * Returns a list of [year, month] pairs (1-indexed month) covering the interval [startMs, endMs).
 */
export function getOverlappingCalendarMonths(startMs: number, endMs: number): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  const start = new Date(startMs);
  const end = new Date(endMs - 1);

  let curYear = start.getUTCFullYear();
  let curMonth = start.getUTCMonth() + 1; // 1-indexed

  const endYear = end.getUTCFullYear();
  const endMonth = end.getUTCMonth() + 1;

  while (curYear < endYear || (curYear === endYear && curMonth <= endMonth)) {
    result.push([curYear, curMonth]);
    curMonth++;
    if (curMonth > 12) {
      curMonth = 1;
      curYear++;
    }
  }

  return result;
}
