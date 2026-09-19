import { tokenPriceError } from "./errors";

export type BinanceKlineInterval =
  | "1s"
  | "1m"
  | "3m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "2h"
  | "4h"
  | "6h"
  | "8h"
  | "12h"
  | "1d"
  | "3d"
  | "1w"
  | "1M";

export interface BinanceKlinePoint {
  readonly timestamp: number;
  readonly priceUsd: string;
}

export interface BinanceFiveMinuteKlineRequest {
  readonly symbol: string;
  readonly start: number | string | Date;
  readonly end: number | string | Date;
  readonly interval?: BinanceKlineInterval | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface NormalizedBinanceFiveMinuteKlineRequest {
  readonly symbol: string;
  readonly interval: BinanceKlineInterval;
  readonly startMs: number;
  readonly endMs: number;
  readonly signal?: AbortSignal | undefined;
}

export interface BinanceFiveMinuteKlineResult {
  readonly provider: "binance";
  readonly symbol: string;
  readonly quoteAsset: "USDT";
  readonly interval: BinanceKlineInterval;
  readonly start: string;
  readonly end: string;
  readonly points: readonly BinanceKlinePoint[];
}

export function normalizeBinanceFiveMinuteKlineRequest(
  request: BinanceFiveMinuteKlineRequest,
): NormalizedBinanceFiveMinuteKlineRequest {
  const symbol = request.symbol.trim().toUpperCase();
  if (!symbol) {
    throw tokenPriceError("TOKEN_NOT_FOUND", "symbol is required.");
  }
  const startMs = parseMs(request.start, "start");
  const endMs = parseMs(request.end, "end");
  if (startMs >= endMs) {
    throw tokenPriceError("PRICE_RANGE_INVALID", "start must be strictly earlier than end.");
  }
  return {
    symbol,
    interval: request.interval ?? "5m",
    startMs,
    endMs,
    ...(request.signal ? { signal: request.signal } : {}),
  };
}

function parseMs(value: number | string | Date, field: string): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw tokenPriceError("PRICE_RANGE_INVALID", `Invalid timestamp for ${field}.`);
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) throw tokenPriceError("PRICE_RANGE_INVALID", `Invalid timestamp string for ${field}: "${value}".`);
    return parsed;
  }
  throw tokenPriceError("PRICE_RANGE_INVALID", `Invalid timestamp type for ${field}.`);
}
