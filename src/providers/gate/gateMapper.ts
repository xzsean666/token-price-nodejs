import type { TokenPricePoint, TokenPriceProviderResult } from "../../domain/priceModels";
import { datesInclusive, decimalText, utcDateFromMilliseconds } from "../../domain/priceOperations";
import type { NormalizedTokenPriceRequest } from "../../domain/priceOperations";

export function mapGateCandles(
  rows: readonly unknown[],
  request: NormalizedTokenPriceRequest,
  nowMs: number,
): readonly TokenPricePoint[] {
  const points = new Map<string, TokenPricePoint>();
  const today = utcDateFromMilliseconds(nowMs);
  for (const raw of rows) {
    if (!Array.isArray(raw) || raw.length < 6) throw new Error("Invalid Gate candle.");
    const timestampSec = Number(raw[0]);
    const quoteVolume = decimalText(raw[1]);
    const close = decimalText(raw[2]);
    const high = decimalText(raw[3]);
    const low = decimalText(raw[4]);
    const open = decimalText(raw[5]);
    const confirmed = raw[7];
    if (!Number.isSafeInteger(timestampSec) || open === null || high === null || low === null || close === null) {
      throw new Error("Invalid Gate candle.");
    }
    const milliseconds = timestampSec * 1000;
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
        volume: quoteVolume,
        isFinal:
          confirmed === "true" || confirmed === true
            ? true
            : confirmed === "false" || confirmed === false
            ? false
            : date < today,
      }),
    );
  }
  return Object.freeze([...points.values()].sort((left, right) => left.date.localeCompare(right.date)));
}

export function gateResult(
  request: NormalizedTokenPriceRequest,
  points: readonly TokenPricePoint[],
): TokenPriceProviderResult {
  const present = new Set(points.map((point) => point.date));
  return Object.freeze({
    provider: "gate",
    status: "success",
    token: Object.freeze({
      input: request.tokenInput,
      normalized: request.normalizedToken,
      symbol: request.baseSymbol,
      name: null,
    }),
    market: Object.freeze({
      product: `${request.baseSymbol}_USDT`,
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
      datesInclusive(request.resolvedRange.startDate, request.resolvedRange.endDate).filter(
        (date) => !present.has(date),
      ),
    ),
  });
}
