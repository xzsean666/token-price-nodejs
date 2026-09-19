import type { KlinePoint, KlineResult, NormalizedKlineRequest } from "../domain/klineModels";
import type { TokenSupportService } from "./TokenSupportService";
import type { KlineArchiveManager } from "../archive/KlineArchiveManager";
import type { BinanceAdapter } from "../providers/binance/BinanceAdapter";
import type { GateAdapter } from "../providers/gate/GateAdapter";
import { TokenPriceError } from "../domain/errors";
import { fetchBinanceFiveMinuteKlines } from "../providers/binance/binanceFiveMinute";
import type { HttpTransport } from "../transport/HttpTransport";
import { AxiosHttpTransport } from "../transport/AxiosHttpTransport";

export interface UnifiedKlineServiceOptions {
  readonly transport?: HttpTransport | undefined;
  readonly gateBaseUrl?: string | undefined;
  readonly binanceBaseUrl?: string | undefined;
}

export class UnifiedKlineService {
  private readonly transport: HttpTransport;
  private readonly gateBaseUrl: string;
  private readonly binanceBaseUrl: string;

  constructor(
    private readonly tokenSupport: TokenSupportService,
    private readonly archiveManager: KlineArchiveManager,
    private readonly binanceAdapter: BinanceAdapter | null = null,
    private readonly gateAdapter: GateAdapter | null = null,
    options: UnifiedKlineServiceOptions = {},
  ) {
    this.transport = options.transport ?? new AxiosHttpTransport();
    this.gateBaseUrl = (options.gateBaseUrl ?? "https://api.gateio.ws").replace(/\/$/, "");
    this.binanceBaseUrl = (options.binanceBaseUrl ?? "https://api.binance.com").replace(/\/$/, "");
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
      }
    }

    // 2. Recent REST API portion: any range in the current natural month
    if (request.endMs > currentMonthStartMs) {
      const recentStartMs = Math.max(request.startMs, currentMonthStartMs);
      const recentPoints =
        provider === "binance"
          ? await this.fetchRecentBinance(marketSymbol, request.interval, recentStartMs, request.endMs, request.signal)
          : await this.fetchRecentGate(marketSymbol, request.interval, recentStartMs, request.endMs, request.signal);

      for (const p of recentPoints) {
        pointsMap.set(p.timestamp, p);
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
