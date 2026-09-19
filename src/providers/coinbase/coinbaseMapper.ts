import type { TokenPricePoint, TokenPriceProviderResult } from "../../domain/priceModels";
import { datesInclusive, decimalText, utcDateFromMilliseconds } from "../../domain/priceOperations";
import type { NormalizedTokenPriceRequest } from "../../domain/priceOperations";
import type { CoinbaseCandle } from "./coinbaseSchemas";

export function mapCoinbaseCandles(
  rows: readonly CoinbaseCandle[],
  request: NormalizedTokenPriceRequest,
  nowMs: number,
): readonly TokenPricePoint[] {
  const byDate = new Map<string, TokenPricePoint>();
  const today = utcDateFromMilliseconds(nowMs);
  for (const row of rows) {
    const seconds = row[0];
    const low = decimalText(row[1]);
    const high = decimalText(row[2]);
    const open = decimalText(row[3]);
    const close = decimalText(row[4]);
    const volume = decimalText(row[5]);
    if (
      typeof seconds !== "number" ||
      !Number.isSafeInteger(seconds) ||
      seconds < 0 ||
      low === null ||
      high === null ||
      open === null ||
      close === null ||
      volume === null
    ) {
      throw new Error("Invalid Coinbase daily candle.");
    }
    const milliseconds = seconds * 1_000;
    const date = utcDateFromMilliseconds(milliseconds);
    if (date < request.resolvedRange.startDate || date > request.resolvedRange.endDate) continue;
    byDate.set(
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
        isFinal: date < today,
      }),
    );
  }
  return Object.freeze([...byDate.values()].sort((left, right) => left.date.localeCompare(right.date)));
}

export function coinbaseResult(
  request: NormalizedTokenPriceRequest,
  points: readonly TokenPricePoint[],
): TokenPriceProviderResult {
  const present = new Set(points.map((point) => point.date));
  return Object.freeze({
    provider: "coinbase",
    status: "success",
    token: Object.freeze({
      input: request.tokenInput,
      normalized: request.normalizedToken,
      symbol: request.baseSymbol,
      name: null,
    }),
    market: Object.freeze({
      product: request.baseSymbol + "-USD",
      quoteAsset: "USD",
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
