import { AxiosHttpTransport } from "../../transport/AxiosHttpTransport";
import { parseHttpProxyUrl, type HttpTransport } from "../../transport/HttpTransport";
import { TokenPriceError } from "../../domain/errors";
import type { TokenPriceProviderResult } from "../../domain/priceModels";
import { addUtcDays, utcStartMilliseconds } from "../../domain/priceOperations";
import type { NormalizedTokenPriceRequest } from "../../domain/priceOperations";
import type { PriceProviderAttemptContext, TokenPriceProviderAdapter } from "../TokenPriceProviderAdapter";
import { classifyGateResponse, normalizeGateTransportError } from "./gateErrors";
import { gateResult, mapGateCandles } from "./gateMapper";
import { gateCandlesSchema, gateCurrencyPairSchema } from "./gateSchemas";

export const GATE_SPOT_BASE_URL = "https://api.gateio.ws";
export const GATE_SPOT_ENDPOINTS = Object.freeze(["https://api.gateio.ws"]);
const CANDLE_CHUNK_DAYS = 180;

export interface GateAdapterOptions {
  readonly transport?: HttpTransport | undefined;
  readonly baseUrl?: string | undefined;
  readonly baseUrls?: readonly string[] | undefined;
  readonly allowInsecureHttp?: boolean | undefined;
}

export class GateAdapter implements TokenPriceProviderAdapter {
  readonly name = "gate" as const;
  private readonly transport: HttpTransport;
  private readonly baseUrls: readonly string[];
  private nextEndpointIndex = 0;

  constructor(options: GateAdapterOptions = {}) {
    this.transport = options.transport ?? new AxiosHttpTransport();
    const envEndpoints = (typeof process !== "undefined" && process.env?.GATE_API_BASE_URLS?.trim() || "")
      .split(",")
      .map((value) => value.trim().replace(/\/$/, ""))
      .filter(Boolean);
    const configured =
      options.baseUrls ??
      (options.baseUrl ? [options.baseUrl] : envEndpoints.length > 0 ? envEndpoints : GATE_SPOT_ENDPOINTS);
    this.baseUrls = Object.freeze([
      ...new Set(configured.map((value) => normalizeBaseUrl(value, options.allowInsecureHttp ?? false))),
    ]);
    if (this.baseUrls.length === 0) throw new Error("Gate endpoint pool is empty.");
  }

  supports(): boolean {
    return true;
  }

  async getPriceHistory(
    request: NormalizedTokenPriceRequest,
    context: PriceProviderAttemptContext,
  ): Promise<TokenPriceProviderResult> {
    const pair = `${request.baseSymbol}_USDT`;

    // 1. Verify that the trading pair exists and is tradable
    const pairInfo = await this.call(`/api/v4/spot/currency_pairs/${pair}`, {}, context);
    const parsedPair = gateCurrencyPairSchema.safeParse(pairInfo);
    if (!parsedPair.success || parsedPair.data.trade_status !== "tradable") {
      throw new TokenPriceError({
        code: "MARKET_NOT_FOUND",
        message: `Gate active Spot USDT market was not found for "${pair}".`,
        retryable: false,
        provider: this.name,
      });
    }

    // 2. Fetch daily candlesticks in chunks
    const rows: unknown[] = [];
    for (const [startDate, endDate] of chunks(
      request.resolvedRange.startDate,
      request.resolvedRange.endDate,
      CANDLE_CHUNK_DAYS,
    )) {
      const fromSec = Math.floor(utcStartMilliseconds(startDate) / 1000);
      const toSec = Math.floor(utcStartMilliseconds(addUtcDays(endDate, 1)) / 1000) - 1;
      const body = await this.call(
        "/api/v4/spot/candlesticks",
        {
          currency_pair: pair,
          interval: "1d",
          from: fromSec,
          to: toSec,
          limit: CANDLE_CHUNK_DAYS,
        },
        context,
      );

      const parsed = gateCandlesSchema.safeParse(body);
      if (!parsed.success) {
        throw new TokenPriceError({
          code: "INVALID_PROVIDER_RESPONSE",
          message: "Gate returned malformed daily candle data.",
          retryable: false,
          provider: this.name,
        });
      }
      rows.push(...parsed.data);
    }

    try {
      return gateResult(request, mapGateCandles(rows, request, context.nowMs));
    } catch (error: unknown) {
      throw new TokenPriceError({
        code: "INVALID_PROVIDER_RESPONSE",
        message: "Gate returned invalid daily candle data.",
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
          headers: { accept: "application/json" },
          timeoutMs: context.timeoutMs,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          proxy: context.proxy === null ? null : parseHttpProxyUrl(context.proxy.url),
        });
        const failure = classifyGateResponse(response);
        if (failure !== null) throw failure;
        return response.body;
      } catch (error) {
        if (error instanceof TokenPriceError && (!error.retryable || error.code === "RATE_LIMITED")) throw error;
        lastError = error;
      }
    }
    if (lastError instanceof TokenPriceError) throw lastError;
    throw (
      normalizeGateTransportError(lastError) ??
      new TokenPriceError({
        code: "PROVIDER_UNAVAILABLE",
        message: "Gate request failed.",
        retryable: true,
        provider: this.name,
      })
    );
  }

  private orderedEndpoints(): readonly string[] {
    const start = this.nextEndpointIndex++ % this.baseUrls.length;
    return Object.freeze(this.baseUrls.map((_, index) => this.baseUrls[(start + index) % this.baseUrls.length]!));
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
    throw new Error("Gate base URL must be an approved HTTP(S) URL.");
  }
  return value.replace(/\/$/, "");
}
