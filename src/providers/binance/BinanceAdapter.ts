import { AxiosHttpTransport } from "../../transport/AxiosHttpTransport";
import { parseHttpProxyUrl, type HttpTransport } from "../../transport/HttpTransport";
import { TokenPriceError } from "../../domain/errors";
import type { TokenPriceProviderResult } from "../../domain/priceModels";
import { addUtcDays, utcStartMilliseconds } from "../../domain/priceOperations";
import type { NormalizedTokenPriceRequest } from "../../domain/priceOperations";
import type { PriceProviderAttemptContext, TokenPriceProviderAdapter } from "../TokenPriceProviderAdapter";
import { classifyBinanceResponse, normalizeBinanceTransportError } from "./binanceErrors";
import { binanceResult, mapBinanceKlines } from "./binanceMapper";
import { binanceExchangeInfoSchema, binanceKlinesSchema } from "./binanceSchemas";
import type { BinanceFiveMinuteKlineResult, BinanceKlineInterval } from "../../domain/binanceKlineModels";
import { fetchBinanceFiveMinuteKlines } from "./binanceFiveMinute";

export const BINANCE_SPOT_BASE_URL = "https://api.binance.com";
export const BINANCE_SPOT_ENDPOINTS = Object.freeze([
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
  "https://api4.binance.com",
  "https://data-api.binance.vision",
]);

const CANDLE_CHUNK_DAYS = 1_000;

export interface BinanceAdapterOptions {
  readonly transport?: HttpTransport | undefined;
  readonly baseUrl?: string | undefined;
  readonly baseUrls?: readonly string[] | undefined;
  readonly allowInsecureHttp?: boolean | undefined;
}

export class BinanceAdapter implements TokenPriceProviderAdapter {
  readonly name = "binance" as const;
  private readonly transport: HttpTransport;
  private readonly baseUrls: readonly string[];
  private nextEndpointIndex = 0;

  constructor(options: BinanceAdapterOptions = {}) {
    this.transport = options.transport ?? new AxiosHttpTransport();
    const configured = options.baseUrls ?? (options.baseUrl ? [options.baseUrl] : BINANCE_SPOT_ENDPOINTS);
    this.baseUrls = Object.freeze(
      [...new Set(configured.map((value) => normalizeBaseUrl(value, options.allowInsecureHttp ?? false)))].filter(
        isApprovedEndpoint,
      ),
    );
    if (this.baseUrls.length === 0) throw new Error("Binance endpoint pool is empty.");
  }

  supports(): boolean {
    return true;
  }

  async getFiveMinuteKlines(
    symbol: string,
    startMs: number,
    endMs: number,
    context: PriceProviderAttemptContext,
    interval: BinanceKlineInterval = "5m",
  ): Promise<BinanceFiveMinuteKlineResult["points"]> {
    let lastError: unknown;
    for (const endpoint of this.orderedEndpoints()) {
      try {
        return await fetchBinanceFiveMinuteKlines(this.transport, endpoint, symbol, interval, startMs, endMs, context);
      } catch (error) {
        lastError = error;
        if (error instanceof TokenPriceError && !error.retryable) throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new TokenPriceError({
          code: "PROVIDER_UNAVAILABLE",
          message: "Binance endpoint pool is unavailable.",
          retryable: true,
          provider: this.name,
        });
  }

  private orderedEndpoints(): readonly string[] {
    const start = this.nextEndpointIndex++ % this.baseUrls.length;
    return Object.freeze(this.baseUrls.map((_, index) => this.baseUrls[(start + index) % this.baseUrls.length]!));
  }

  async getPriceHistory(
    request: NormalizedTokenPriceRequest,
    context: PriceProviderAttemptContext,
  ): Promise<TokenPriceProviderResult> {
    const symbol = request.baseSymbol + "USDT";
    const metadata = await this.call("/api/v3/exchangeInfo", { symbol }, context);
    const parsedMetadata = binanceExchangeInfoSchema.safeParse(metadata);
    const market = parsedMetadata.success
      ? parsedMetadata.data.symbols.find(
          (candidate) => candidate.symbol === symbol && candidate.status === "TRADING" && candidate.isSpotTradingAllowed !== false,
        )
      : undefined;

    if (market === undefined) {
      throw new TokenPriceError({
        code: "MARKET_NOT_FOUND",
        message: "Binance active Spot USDT market was not found.",
        retryable: false,
        provider: this.name,
      });
    }

    const rows = [];
    for (const [startDate, endDate] of chunks(request.resolvedRange.startDate, request.resolvedRange.endDate, CANDLE_CHUNK_DAYS)) {
      const body = await this.call(
        "/api/v3/klines",
        {
          symbol,
          interval: "1d",
          startTime: utcStartMilliseconds(startDate),
          endTime: utcStartMilliseconds(addUtcDays(endDate, 1)) - 1,
          limit: CANDLE_CHUNK_DAYS,
        },
        context,
      );
      const parsedRows = binanceKlinesSchema.safeParse(body);
      if (!parsedRows.success) {
        throw new TokenPriceError({
          code: "INVALID_PROVIDER_RESPONSE",
          message: "Binance returned malformed daily candle data.",
          retryable: false,
          provider: this.name,
        });
      }
      rows.push(...parsedRows.data);
    }

    try {
      return binanceResult(request, mapBinanceKlines(rows, request, context.nowMs));
    } catch (error) {
      throw new TokenPriceError({
        code: "INVALID_PROVIDER_RESPONSE",
        message: "Binance returned invalid daily candle data.",
        retryable: false,
        provider: this.name,
        cause: error,
      });
    }
  }

  private async call(
    path: string,
    params: Record<string, string | number>,
    context: PriceProviderAttemptContext,
  ): Promise<unknown> {
    let lastError: unknown;
    for (const endpoint of this.orderedEndpoints()) {
      try {
        const response = await this.transport.request({
          method: "GET",
          url: endpoint + path,
          params,
          timeoutMs: context.timeoutMs,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          proxy: context.proxy === null ? null : parseHttpProxyUrl(context.proxy.url),
        });
        const failure = classifyBinanceResponse(response);
        if (failure !== null) throw failure;
        return response.body;
      } catch (error) {
        if (error instanceof TokenPriceError && (!error.retryable || error.code === "RATE_LIMITED")) throw error;
        lastError = error;
      }
    }
    if (lastError instanceof TokenPriceError) throw lastError;
    throw (
      normalizeBinanceTransportError(lastError) ??
      new TokenPriceError({
        code: "PROVIDER_UNAVAILABLE",
        message: "Binance request failed.",
        retryable: true,
        provider: this.name,
      })
    );
  }
}

function chunks(startDate: string, endDate: string, length: number): readonly (readonly [string, string])[] {
  const result: [string, string][] = [];
  for (let start = startDate; start <= endDate; start = addUtcDays(start, length)) {
    const end = addUtcDays(start, length - 1);
    result.push([start, end < endDate ? end : endDate]);
  }
  return result;
}

function normalizeBaseUrl(value: string, allowInsecureHttp: boolean): string {
  const parsed = new URL(value);
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  const allowedProtocol = parsed.protocol === "https:" || (parsed.protocol === "http:" && (allowInsecureHttp || loopback));
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" || !allowedProtocol) {
    throw new Error("Binance base URL must be an approved HTTP(S) URL.");
  }
  return value.replace(/\/$/, "");
}

function isApprovedEndpoint(value: string): boolean {
  const hostname = new URL(value).hostname.toLowerCase();
  return (
    hostname === "api.binance.com" ||
    /^api[1-4]\.binance\.com$/.test(hostname) ||
    hostname === "data-api.binance.vision"
  );
}
