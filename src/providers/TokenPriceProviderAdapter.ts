import type { TokenPriceProviderResult, TokenPriceProviderName } from "../domain/priceModels";
import type { NormalizedTokenPriceRequest } from "../domain/priceOperations";

/** A route leased for one price-provider attempt. */
export interface PriceProxyLease {
  readonly id: string;
  readonly url: string;
  readonly leaseToken?: number | undefined;
}

export interface PriceProviderAttemptContext {
  readonly proxy: PriceProxyLease | null;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly correlationId: string;
  /** UTC attempt time supplied by the executor for deterministic candle finality. */
  readonly nowMs: number;
}

export interface TokenPriceProviderAdapter {
  readonly name: TokenPriceProviderName;

  supports(request: NormalizedTokenPriceRequest): boolean;

  getPriceHistory(
    request: NormalizedTokenPriceRequest,
    context: PriceProviderAttemptContext,
  ): Promise<TokenPriceProviderResult>;
}
