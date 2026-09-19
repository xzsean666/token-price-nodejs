import { AxiosHttpTransport } from "../../transport/AxiosHttpTransport";
import { parseHttpProxyUrl, type HttpTransport } from "../../transport/HttpTransport";
import { TokenPriceError } from "../../domain/errors";
import type { TokenPriceProviderResult } from "../../domain/priceModels";
import { addUtcDays, utcStartMilliseconds } from "../../domain/priceOperations";
import type { NormalizedTokenPriceRequest } from "../../domain/priceOperations";
import type { PriceProviderAttemptContext, TokenPriceProviderAdapter } from "../TokenPriceProviderAdapter";
import { classifyOkxEnvelope, classifyOkxResponse, normalizeOkxTransportError } from "./okxErrors";
import { mapOkxCandles, okxResult } from "./okxMapper";
import { okxEnvelopeSchema, okxInstrumentSchema } from "./okxSchemas";

export const OKX_SPOT_BASE_URL = "https://www.okx.com";
const CANDLE_CHUNK_DAYS = 100;

export interface OkxAdapterOptions {
  readonly transport?: HttpTransport | undefined;
  readonly baseUrl?: string | undefined;
  readonly allowInsecureHttp?: boolean | undefined;
}

export class OkxAdapter implements TokenPriceProviderAdapter {
  readonly name = "okx" as const;
  private readonly transport: HttpTransport;
  private readonly baseUrl: string;

  constructor(options: OkxAdapterOptions = {}) {
    this.transport = options.transport ?? new AxiosHttpTransport();
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? OKX_SPOT_BASE_URL, options.allowInsecureHttp ?? false);
  }

  supports(): boolean {
    return true;
  }

  async getPriceHistory(
    request: NormalizedTokenPriceRequest,
    context: PriceProviderAttemptContext,
  ): Promise<TokenPriceProviderResult> {
    const product = request.baseSymbol + "-USDT";
    const instruments = await this.envelope("/api/v5/public/instruments", { instType: "SPOT" }, context);
    const market = instruments.data
      .map((value) => okxInstrumentSchema.safeParse(value))
      .find((value) => value.success && value.data.instId === product && value.data.instType === "SPOT" && value.data.state === "live");
    if (market === undefined) {
      throw new TokenPriceError({
        code: "MARKET_NOT_FOUND",
        message: "OKX active Spot USDT market was not found.",
        retryable: false,
        provider: this.name,
      });
    }

    const candleRows: unknown[] = [];
    for (const [startDate, endDate] of chunks(request.resolvedRange.startDate, request.resolvedRange.endDate, CANDLE_CHUNK_DAYS)) {
      const candles = await this.envelope(
        "/api/v5/market/history-candles",
        {
          instId: product,
          bar: "1Dutc",
          before: String(utcStartMilliseconds(addUtcDays(endDate, 1))),
          after: String(utcStartMilliseconds(startDate) - 1),
          limit: CANDLE_CHUNK_DAYS,
        },
        context,
      );
      candleRows.push(...candles.data);
    }
    try {
      return okxResult(request, mapOkxCandles(candleRows, request, context.nowMs));
    } catch (error: unknown) {
      throw new TokenPriceError({
        code: "INVALID_PROVIDER_RESPONSE",
        message: "OKX returned invalid daily candle data.",
        retryable: false,
        provider: this.name,
        cause: error,
      });
    }
  }

  private async envelope(
    path: string,
    params: Record<string, string | number>,
    context: PriceProviderAttemptContext,
  ): Promise<{ code: string; msg?: string; data: unknown[] }> {
    try {
      const response = await this.transport.request({
        method: "GET",
        url: this.baseUrl + path,
        params,
        timeoutMs: context.timeoutMs,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        proxy: context.proxy === null ? null : parseHttpProxyUrl(context.proxy.url),
      });
      const failure = classifyOkxResponse(response);
      if (failure !== null) throw failure;
      const parsed = okxEnvelopeSchema.safeParse(response.body);
      if (!parsed.success) {
        throw new TokenPriceError({
          code: "INVALID_PROVIDER_RESPONSE",
          message: "OKX returned a malformed response.",
          retryable: false,
          provider: this.name,
        });
      }
      const envelopeFailure = classifyOkxEnvelope(parsed.data.code, parsed.data.msg);
      if (envelopeFailure !== null) throw envelopeFailure;
      return {
        code: parsed.data.code,
        ...(parsed.data.msg === undefined ? {} : { msg: parsed.data.msg }),
        data: parsed.data.data,
      };
    } catch (error: unknown) {
      if (error instanceof TokenPriceError) throw error;
      throw (
        normalizeOkxTransportError(error) ??
        new TokenPriceError({
          code: "PROVIDER_UNAVAILABLE",
          message: "OKX request failed.",
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
    throw new Error("OKX base URL must be an approved HTTP(S) URL.");
  }
  return value.replace(/\/$/, "");
}
