import { AxiosHttpTransport } from "../../transport/AxiosHttpTransport";
import { parseHttpProxyUrl, type HttpTransport } from "../../transport/HttpTransport";
import { TokenPriceError } from "../../domain/errors";
import type { TokenPriceProviderResult } from "../../domain/priceModels";
import { addUtcDays, utcStartMilliseconds } from "../../domain/priceOperations";
import type { NormalizedTokenPriceRequest } from "../../domain/priceOperations";
import type { PriceProviderAttemptContext, TokenPriceProviderAdapter } from "../TokenPriceProviderAdapter";
import { classifyGeckoResponse, normalizeGeckoTransportError } from "./geckoTerminalErrors";
import { geckoResult, mapGeckoOhlcv, resolveGeckoPool } from "./geckoTerminalMapper";
import { geckoOhlcvSchema, geckoSearchSchema } from "./geckoTerminalSchemas";

export const GECKO_TERMINAL_BASE_URL = "https://api.geckoterminal.com/api/v2";

export interface GeckoTerminalAdapterOptions {
  readonly transport?: HttpTransport | undefined;
  readonly baseUrl?: string | undefined;
  readonly allowInsecureHttp?: boolean | undefined;
  readonly networks?: readonly string[] | undefined;
}

export class GeckoTerminalAdapter implements TokenPriceProviderAdapter {
  readonly name = "geckoterminal" as const;

  private readonly transport: HttpTransport;
  private readonly baseUrl: string;
  private readonly networks: readonly string[];

  constructor(options: GeckoTerminalAdapterOptions = {}) {
    this.transport = options.transport ?? new AxiosHttpTransport();
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? GECKO_TERMINAL_BASE_URL, options.allowInsecureHttp ?? false);
    this.networks = Object.freeze([...(options.networks ?? ["eth", "bsc", "polygon_pos", "arbitrum", "base", "optimism"])]);
  }

  supports(): boolean {
    return true;
  }

  async getPriceHistory(
    request: NormalizedTokenPriceRequest,
    context: PriceProviderAttemptContext,
  ): Promise<TokenPriceProviderResult> {
    const search = geckoSearchSchema.safeParse(await this.call("/search/pools", { query: request.tokenInput }, context));
    if (!search.success) {
      throw new TokenPriceError({
        code: "INVALID_PROVIDER_RESPONSE",
        message: "GeckoTerminal returned a malformed search response.",
        retryable: false,
        provider: this.name,
      });
    }
    let resolution;
    try {
      resolution = resolveGeckoPool(search.data.data, search.data.included ?? [], request, this.networks);
    } catch (error: unknown) {
      const code = error instanceof Error && error.message === "TOKEN_AMBIGUOUS" ? "TOKEN_AMBIGUOUS" : "TOKEN_NOT_FOUND";
      throw new TokenPriceError({
        code,
        message:
          code === "TOKEN_AMBIGUOUS"
            ? "GeckoTerminal found multiple indistinguishable token matches."
            : "GeckoTerminal did not find a matching token pool.",
        retryable: false,
        provider: this.name,
      });
    }
    const ohlcv = geckoOhlcvSchema.safeParse(
      await this.call(
        "/networks/" + encodeURIComponent(resolution.network) + "/pools/" + encodeURIComponent(resolution.poolAddress) + "/ohlcv/day",
        {
          aggregate: 1,
          before_timestamp: Math.floor(utcStartMilliseconds(addUtcDays(request.resolvedRange.endDate, 1)) / 1_000),
          currency: "usd",
          token: resolution.tokenSide,
          limit: 1_000,
        },
        context,
      ),
    );
    if (!ohlcv.success) {
      throw new TokenPriceError({
        code: "INVALID_PROVIDER_RESPONSE",
        message: "GeckoTerminal returned malformed daily candle data.",
        retryable: false,
        provider: this.name,
      });
    }
    try {
      return geckoResult(request, resolution, mapGeckoOhlcv(ohlcv.data.data.attributes.ohlcv_list, request, context.nowMs));
    } catch (error: unknown) {
      throw new TokenPriceError({
        code: "INVALID_PROVIDER_RESPONSE",
        message: "GeckoTerminal returned invalid daily candle data.",
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
      const error = classifyGeckoResponse(response);
      if (error !== null) throw error;
      return response.body;
    } catch (error: unknown) {
      if (error instanceof TokenPriceError) throw error;
      throw (
        normalizeGeckoTransportError(error) ??
        new TokenPriceError({
          code: "PROVIDER_UNAVAILABLE",
          message: "GeckoTerminal request failed.",
          retryable: true,
          provider: this.name,
        })
      );
    }
  }
}

function normalizeBaseUrl(value: string, allowInsecureHttp: boolean): string {
  const parsed = new URL(value);
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  const allowedProtocol = parsed.protocol === "https:" || (parsed.protocol === "http:" && (allowInsecureHttp || loopback));
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" || !allowedProtocol) {
    throw new Error("GeckoTerminal base URL must be an approved HTTP(S) URL.");
  }
  return value.replace(/\/$/, "");
}
