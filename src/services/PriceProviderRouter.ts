import { unsupportedOperation } from "../domain/errors";
import type { NormalizedTokenPriceRequest } from "../domain/priceOperations";
import type { TokenPriceProviderAdapter } from "../providers/TokenPriceProviderAdapter";

export class PriceProviderRouter {
  constructor(private readonly adapters: readonly TokenPriceProviderAdapter[]) {}

  route(request: NormalizedTokenPriceRequest): readonly TokenPriceProviderAdapter[] {
    const candidates = this.adapters.filter((adapter) => adapter.supports(request));
    if (candidates.length === 0) {
      throw unsupportedOperation("No configured token price provider supports this request.");
    }
    return candidates;
  }
}
