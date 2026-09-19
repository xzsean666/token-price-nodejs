import type { TokenPriceAggregationResult } from "../domain/priceModels";
import type { NormalizedTokenPriceRequest } from "../domain/priceOperations";
import { PriceProviderRouter } from "./PriceProviderRouter";
import { PriceRequestExecutor } from "./PriceRequestExecutor";

export class TokenPriceAggregator {
  constructor(
    private readonly router: PriceProviderRouter,
    private readonly executor: PriceRequestExecutor,
  ) {}

  getPriceHistory(request: NormalizedTokenPriceRequest): Promise<TokenPriceAggregationResult> {
    return this.executor.execute(request, this.router.route(request));
  }
}
