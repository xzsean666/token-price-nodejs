import { TokenPriceError } from "../../domain/errors";
import type { BinanceFiveMinuteKlineResult, BinanceKlineInterval } from "../../domain/binanceKlineModels";
import { binanceKlinesSchema, type BinanceKline } from "./binanceSchemas";
import { classifyBinanceResponse } from "./binanceErrors";
import type { HttpTransport } from "../../transport/HttpTransport";
import { parseHttpProxyUrl } from "../../transport/HttpTransport";
import type { PriceProviderAttemptContext } from "../TokenPriceProviderAdapter";

export async function fetchBinanceFiveMinuteKlines(
  transport: HttpTransport,
  baseUrl: string,
  symbol: string,
  interval: BinanceKlineInterval,
  startMs: number,
  endMs: number,
  context: PriceProviderAttemptContext,
): Promise<BinanceFiveMinuteKlineResult["points"]> {
  const intervalMs = intervalMilliseconds(interval);
  const alignedStart = Math.floor(startMs / intervalMs) * intervalMs;
  const alignedEnd = Math.floor(endMs / intervalMs) * intervalMs;
  if (alignedEnd <= alignedStart) return Object.freeze([]);

  const rows: BinanceKline[] = [];
  let cursor = alignedStart;

  while (cursor < alignedEnd) {
    const response = await transport.request({
      method: "GET",
      url: baseUrl + "/api/v3/klines",
      params: { symbol, interval, startTime: cursor, endTime: alignedEnd - 1, limit: 1000 },
      timeoutMs: context.timeoutMs,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      proxy: context.proxy === null ? null : parseHttpProxyUrl(context.proxy.url),
    });

    const failure = classifyBinanceResponse(response);
    if (failure !== null) throw failure;

    const parsed = binanceKlinesSchema.safeParse(response.body);
    if (!parsed.success) {
      throw new TokenPriceError({
        code: "INVALID_PROVIDER_RESPONSE",
        message: "Binance returned malformed candle data.",
        retryable: false,
        provider: "binance",
      });
    }

    if (parsed.data.length === 0) break;
    rows.push(...parsed.data);

    const last = parsed.data[parsed.data.length - 1]?.[0];
    if (typeof last !== "number" || !Number.isSafeInteger(last) || last < cursor) {
      throw new TokenPriceError({
        code: "INVALID_PROVIDER_RESPONSE",
        message: "Binance returned non-advancing candle data.",
        retryable: false,
        provider: "binance",
      });
    }

    const next = last + intervalMs;
    if (next <= cursor) {
      throw new TokenPriceError({
        code: "INVALID_PROVIDER_RESPONSE",
        message: "Binance returned a non-advancing candle page.",
        retryable: false,
        provider: "binance",
      });
    }

    cursor = next;
    if (parsed.data.length < 1000) break;
  }

  const points = new Map<number, { timestamp: number; priceUsd: string }>();
  for (const row of rows) {
    const timestamp = row[0];
    const close = row[4];
    if (
      typeof timestamp !== "number" ||
      !Number.isSafeInteger(timestamp) ||
      timestamp % intervalMs !== 0 ||
      timestamp < startMs ||
      timestamp >= endMs ||
      (typeof close !== "string" && typeof close !== "number")
    ) {
      continue;
    }

    const priceUsd = String(close);
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(priceUsd) || Number(priceUsd) <= 0 || !Number.isFinite(Number(priceUsd))) {
      continue;
    }
    points.set(timestamp, { timestamp, priceUsd });
  }

  return Object.freeze(
    [...points.entries()].sort((a, b) => a[0] - b[0]).map(([, point]) => Object.freeze(point)),
  );
}

function intervalMilliseconds(interval: BinanceKlineInterval): number {
  const units: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, s: 1_000 };
  const match = /^(\d+)([smhd])$/.exec(interval);
  if (match === null) throw new Error(`Unsupported Binance interval: ${interval}`);
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === undefined || units[unit] === undefined) throw new Error(`Unsupported Binance interval: ${interval}`);
  return amount * units[unit];
}
