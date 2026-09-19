import type { TokenPriceRange } from "./priceOperations";

export const TOKEN_PRICE_PROVIDER_NAMES = [
  "binance",
  "okx",
  "coinbase",
  "geckoterminal",
  "gate",
] as const;

export type TokenPriceProviderName = (typeof TOKEN_PRICE_PROVIDER_NAMES)[number];

export interface TokenPricePoint {
  readonly date: string;
  readonly timestamp: string;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly price: string;
  readonly volume: string | null;
  readonly isFinal: boolean | null;
}

export interface TokenPriceProviderResult {
  readonly provider: TokenPriceProviderName;
  readonly status: "success";
  readonly token: {
    readonly input: string;
    readonly normalized: string;
    readonly symbol: string;
    readonly name: string | null;
  };
  readonly market: {
    readonly product: string;
    readonly quoteAsset: "USD" | "USDT";
    readonly sourceKind: "exchange" | "onchain";
    readonly network: string | null;
    readonly tokenAddress: string | null;
    readonly poolAddress: string | null;
  };
  readonly interval: "1d";
  readonly timezone: "UTC";
  readonly requestedRange: ResolvedTokenPriceRange;
  readonly points: readonly TokenPricePoint[];
  readonly missingDates: readonly string[];
}

export interface TokenPriceProviderFailure {
  readonly provider: TokenPriceProviderName;
  readonly code: TokenPriceProviderFailureCode;
  readonly retryable: boolean;
  readonly message: string;
}

export type TokenPriceProviderFailureCode =
  | "TOKEN_NOT_FOUND"
  | "TOKEN_AMBIGUOUS"
  | "MARKET_NOT_FOUND"
  | "HISTORY_NOT_AVAILABLE"
  | "RATE_LIMITED"
  | "REQUEST_TIMEOUT"
  | "NETWORK_ERROR"
  | "PROXY_ERROR"
  | "INVALID_PROVIDER_RESPONSE"
  | "PROVIDER_UNAVAILABLE";

export interface ResolvedTokenPriceRange {
  readonly kind: TokenPriceRange["kind"];
  readonly startDate: string;
  readonly endDate: string;
}

export interface TokenPriceAggregationResult {
  readonly query: {
    readonly tokenInput: string;
    readonly normalizedToken: string;
    readonly interval: "1d";
    readonly timezone: "UTC";
    readonly range: TokenPriceRange;
    readonly resolvedStartDate: string;
    readonly resolvedEndDate: string;
  };
  readonly results: readonly TokenPriceProviderResult[];
  readonly failures: readonly TokenPriceProviderFailure[];
  readonly summary: {
    readonly requestedProviders: number;
    readonly succeededProviders: number;
    readonly failedProviders: number;
    readonly partial: boolean;
  };
}

export type PriceRouteMode = "balanced" | "proxy-only";

export interface TokenPriceProviderConfig {
  readonly kind: TokenPriceProviderName;
  readonly baseUrl?: string | undefined;
  readonly allowInsecureHttp?: boolean | undefined;
}

export interface TokenPriceConfiguration {
  readonly timeoutMs?: number | undefined;
  readonly attempts?: number | undefined;
  readonly routeMode?: PriceRouteMode | undefined;
  readonly tokenAliases?: Readonly<Record<string, string>> | undefined;
  readonly providers?: readonly TokenPriceProviderConfig[] | undefined;
  readonly geckoNetworks?: readonly string[] | undefined;
}
