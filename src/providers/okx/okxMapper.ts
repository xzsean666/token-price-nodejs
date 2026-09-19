import type { TokenPricePoint, TokenPriceProviderResult } from "../../domain/priceModels";
import { datesInclusive, decimalText, utcDateFromMilliseconds } from "../../domain/priceOperations";
import type { NormalizedTokenPriceRequest } from "../../domain/priceOperations";

export function mapOkxCandles(
  rows: readonly unknown[],
  request: NormalizedTokenPriceRequest,
  nowMs: number,
): readonly TokenPricePoint[] {
  const points = new Map<string, TokenPricePoint>();
  const today = utcDateFromMilliseconds(nowMs);
  for (const raw of rows) {
    if (!Array.isArray(raw)) throw new Error("Invalid OKX candle.");
    const timestamp = raw[0];
    const open = decimalText(raw[1]);
    const high = decimalText(raw[2]);
    const low = decimalText(raw[3]);
    const close = decimalText(raw[4]);
    const volume = decimalText(raw[5]);
    const confirmed = raw[8];
    const milliseconds = typeof timestamp === "string" ? Number(timestamp) : timestamp;
    if (!Number.isSafeInteger(milliseconds) || open === null || high === null || low === null || close === null || volume === null) {
      throw new Error("Invalid OKX candle.");
    }
    const date = utcDateFromMilliseconds(milliseconds);
    if (date < request.resolvedRange.startDate || date > request.resolvedRange.endDate) continue;
    points.set(
      date,
      Object.freeze({
        date,
        timestamp: new Date(milliseconds).toISOString(),
        open,
        high,
        low,
        close,
        price: close,
        volume,
        isFinal: confirmed === "1" || confirmed === 1 ? true : confirmed === "0" || confirmed === 0 ? false : date < today,
      }),
    );
  }
  return Object.freeze([...points.values()].sort((left, right) => left.date.localeCompare(right.date)));
}

export function okxResult(
  request: NormalizedTokenPriceRequest,
  points: readonly TokenPricePoint[],
): TokenPriceProviderResult {
  const present = new Set(points.map((point) => point.date));
  return Object.freeze({
    provider: "okx",
    status: "success",
    token: Object.freeze({
      input: request.tokenInput,
      normalized: request.normalizedToken,
      symbol: request.baseSymbol,
      name: null,
    }),
    market: Object.freeze({
      product: request.baseSymbol + "-USDT",
      quoteAsset: "USDT",
      sourceKind: "exchange",
      network: null,
      tokenAddress: null,
      poolAddress: null,
    }),
    interval: "1d",
    timezone: "UTC",
    requestedRange: request.resolvedRange,
    points,
    missingDates: Object.freeze(
      datesInclusive(request.resolvedRange.startDate, request.resolvedRange.endDate).filter((date) => !present.has(date)),
    ),
  });
}
