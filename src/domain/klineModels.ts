import { tokenPriceError } from "./errors";

export const KLINE_INTERVALS = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "8h",
  "12h",
  "1d",
] as const;

export type KlineInterval = (typeof KLINE_INTERVALS)[number];

export interface KlinePoint {
  readonly timestamp: number; // Unix milliseconds
  readonly priceUsd: string;
}

export interface KlineRequest {
  readonly baseSymbol: string;
  readonly interval: KlineInterval;
  readonly start: number | string | Date;
  readonly end: number | string | Date;
  readonly signal?: AbortSignal | undefined;
}

export interface NormalizedKlineRequest {
  readonly baseSymbol: string;
  readonly interval: KlineInterval;
  readonly startMs: number;
  readonly endMs: number;
  readonly signal?: AbortSignal | undefined;
}

export interface KlineResult {
  readonly provider: "binance" | "gate";
  readonly symbol: string;
  readonly quoteAsset: "USDT";
  readonly interval: KlineInterval;
  readonly start: string;
  readonly end: string;
  readonly points: readonly KlinePoint[];
}

export function normalizeKlineRequest(request: KlineRequest): NormalizedKlineRequest {
  const cleanSymbol = request.baseSymbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cleanSymbol) {
    throw tokenPriceError("TOKEN_NOT_FOUND", "baseSymbol is required.");
  }
  const baseSymbol = cleanSymbol.endsWith("USDT") && cleanSymbol.length > 4 ? cleanSymbol.slice(0, -4) : cleanSymbol;

  const startMs = parseMs(request.start, "start");
  const endMs = parseMs(request.end, "end");

  if (startMs >= endMs) {
    throw tokenPriceError("PRICE_RANGE_INVALID", "start must be strictly earlier than end.");
  }

  return {
    baseSymbol,
    interval: request.interval,
    startMs,
    endMs,
    ...(request.signal ? { signal: request.signal } : {}),
  };
}

function parseMs(value: number | string | Date, field: string): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw tokenPriceError("PRICE_RANGE_INVALID", `Invalid timestamp for ${field}.`);
    }
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw tokenPriceError("PRICE_RANGE_INVALID", `Invalid timestamp for ${field}.`);
      }
      return parsed;
    }
    const parsedDate = Date.parse(trimmed);
    if (Number.isNaN(parsedDate)) {
      throw tokenPriceError("PRICE_RANGE_INVALID", `Invalid timestamp string for ${field}: "${value}".`);
    }
    return parsedDate;
  }
  throw tokenPriceError("PRICE_RANGE_INVALID", `Invalid timestamp type for ${field}.`);
}
