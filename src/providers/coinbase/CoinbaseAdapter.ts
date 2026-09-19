import { AxiosHttpTransport } from "../../transport/AxiosHttpTransport";
import { parseHttpProxyUrl, type HttpTransport } from "../../transport/HttpTransport";
import { TokenPriceError } from "../../domain/errors";
import type { TokenPriceProviderResult } from "../../domain/priceModels";
import { addUtcDays, utcStartMilliseconds } from "../../domain/priceOperations";
import type { NormalizedTokenPriceRequest } from "../../domain/priceOperations";
import type { PriceProviderAttemptContext, TokenPriceProviderAdapter } from "../TokenPriceProviderAdapter";
import { classifyCoinbaseResponse, normalizeCoinbaseTransportError } from "./coinbaseErrors";
import { coinbaseResult, mapCoinbaseCandles } from "./coinbaseMapper";
import { coinbaseCandlesSchema, coinbaseProductsSchema, type CoinbaseCandle } from "./coinbaseSchemas";

export const COINBASE_EXCHANGE_BASE_URL = "https://api.exchange.coinbase.com";
const CANDLE_CHUNK_DAYS = 300;

export interface CoinbaseAdapterOptions {
  readonly transport?: HttpTransport | undefined;
  readonly baseUrl?: string | undefined;
  readonly allowInsecureHttp?: boolean | undefined;
}

export class CoinbaseAdapter implements TokenPriceProviderAdapter {
  readonly name = "coinbase" as const;
  private readonly transport: HttpTransport;
  private readonly baseUrl: string;

  constructor(options: CoinbaseAdapterOptions = {}) {
    this.transport = options.transport ?? new AxiosHttpTransport();
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? COINBASE_EXCHANGE_BASE_URL, options.allowInsecureHttp ?? false);
  }

  supports(): boolean {
    return true;
  }

  async getPriceHistory(
    request: NormalizedTokenPriceRequest,
    context: PriceProviderAttemptContext,
  ): Promise<TokenPriceProviderResult> {
    const product = request.baseSymbol + "-USD";
    const products = coinbaseProductsSchema.safeParse(await this.call("/products", {}, context));
    const market = products.success
      ? products.data.find(
          (candidate) =>
            candidate.id === product &&
            candidate.status !== "delisted" &&
            candidate.status !== "offline" &&
            candidate.trading_disabled !== true &&
            candidate.cancel_only !== true &&
            candidate.post_only !== true,
        )
      : undefined;

    if (market === undefined) {
      throw new TokenPriceError({
        code: "MARKET_NOT_FOUND",
        message: "Coinbase active Spot USD market was not found.",
        retryable: false,
        provider: this.name,
      });
    }

    const rows: CoinbaseCandle[] = [];
    for (const [startDate, endDate] of chunks(
      request.resolvedRange.startDate,
      request.resolvedRange.endDate,
      CANDLE_CHUNK_DAYS,
    )) {
      const body = await this.call(
        "/products/" + product + "/candles",
        {
          granularity: 86_400,
          start: new Date(utcStartMilliseconds(startDate)).toISOString(),
          end: new Date(utcStartMilliseconds(addUtcDays(endDate, 1))).toISOString(),
        },
        context,
      );
      const parsed = coinbaseCandlesSchema.safeParse(body);
      if (!parsed.success) {
        throw new TokenPriceError({
          code: "INVALID_PROVIDER_RESPONSE",
          message: "Coinbase returned malformed daily candle data.",
          retryable: false,
          provider: this.name,
        });
      }
      rows.push(...parsed.data);
    }

    try {
      return coinbaseResult(request, mapCoinbaseCandles(rows, request, context.nowMs));
    } catch (error: unknown) {
      throw new TokenPriceError({
        code: "INVALID_PROVIDER_RESPONSE",
        message: "Coinbase returned invalid daily candle data.",
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
    try {
      const response = await this.transport.request({
        method: "GET",
        url: this.baseUrl + path,
        params,
        timeoutMs: context.timeoutMs,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        proxy: context.proxy === null ? null : parseHttpProxyUrl(context.proxy.url),
      });
      const error = classifyCoinbaseResponse(response);
      if (error !== null) throw error;
      return response.body;
    } catch (error: unknown) {
      if (error instanceof TokenPriceError) throw error;
      throw (
        normalizeCoinbaseTransportError(error) ??
        new TokenPriceError({
          code: "PROVIDER_UNAVAILABLE",
          message: "Coinbase request failed.",
          retryable: true,
          provider: this.name,
        })
      );
    }
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
    throw new Error("Coinbase base URL must be an approved HTTP(S) URL.");
  }
  return value.replace(/\/$/, "");
}
