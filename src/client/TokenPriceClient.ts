import type { HttpTransport } from "../transport/HttpTransport";
import { AxiosHttpTransport } from "../transport/AxiosHttpTransport";
import type { PriceStorage } from "../storage/PriceStorage";
import { createPriceStorage, type CreatePriceStorageOptions } from "../storage/createPriceStorage";
import type { TokenPriceProviderAdapter } from "../providers/TokenPriceProviderAdapter";
import { BinanceAdapter } from "../providers/binance/BinanceAdapter";
import { GateAdapter } from "../providers/gate/GateAdapter";
import { OkxAdapter } from "../providers/okx/OkxAdapter";
import { CoinbaseAdapter } from "../providers/coinbase/CoinbaseAdapter";
import { GeckoTerminalAdapter } from "../providers/geckoterminal/GeckoTerminalAdapter";
import { PriceProviderRouter } from "../services/PriceProviderRouter";
import { PriceRequestExecutor } from "../services/PriceRequestExecutor";
import { TokenPriceAggregator } from "../services/TokenPriceAggregator";
import { TokenSupportStore } from "../services/TokenSupportStore";
import { TokenSupportService } from "../services/TokenSupportService";
import { UnifiedKlineService } from "../services/UnifiedKlineService";
import { PriceSyncService } from "../services/PriceSyncService";
import { KlineArchiveManager } from "../archive/KlineArchiveManager";
import type { TokenPriceHistoryRequest, TokenPriceAggregationResult } from "../domain";
import { normalizeTokenPriceHistoryRequest } from "../domain/priceOperations";
import type { KlineRequest, KlineResult, KlinePoint } from "../domain/klineModels";
import { normalizeKlineRequest } from "../domain/klineModels";
import type { BinanceFiveMinuteKlineRequest, BinanceFiveMinuteKlineResult } from "../domain/binanceKlineModels";
import { normalizeBinanceFiveMinuteKlineRequest } from "../domain/binanceKlineModels";
import type { GateKlineRequest, GateKlinePoint } from "../domain/gateKlineModels";
import { normalizeGateKlineRequest } from "../domain/gateKlineModels";
import type { TokenSupportProvider, TokenSupportStatusMap } from "../domain/tokenSupportModels";
import type { PricePointQuery, PriceAtResult, PriceUpdateRequest, PriceUpdateResult, PriceRecollectRequest, PriceSyncScopeRequest } from "../domain/priceSyncModels";

export interface TokenPriceClientOptions {
  readonly transport?: HttpTransport | undefined;
  readonly storage?: PriceStorage | CreatePriceStorageOptions | undefined;
  readonly tokenAliases?: Readonly<Record<string, string>> | undefined;
  readonly priceAdapters?: readonly TokenPriceProviderAdapter[] | undefined;
  readonly cacheDir?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export class TokenPriceClient {
  readonly storage: PriceStorage;
  readonly tokenSupportStore: TokenSupportStore;
  readonly tokenSupportService: TokenSupportService;
  readonly klineArchiveManager: KlineArchiveManager;
  readonly unifiedKlineService: UnifiedKlineService;
  readonly priceAggregator: TokenPriceAggregator;
  readonly priceSyncService: PriceSyncService;
  readonly binanceAdapter: BinanceAdapter;
  readonly gateAdapter: GateAdapter;
  readonly router: PriceProviderRouter;
  readonly executor: PriceRequestExecutor;
  private readonly tokenAliases: Readonly<Record<string, string>>;

  constructor(options: TokenPriceClientOptions = {}) {
    const transport = options.transport ?? new AxiosHttpTransport();
    this.tokenAliases = options.tokenAliases ?? {};

    // 1. Storage setup
    if (options.storage && "driver" in options.storage) {
      this.storage = options.storage as PriceStorage;
    } else {
      this.storage = createPriceStorage(options.storage as CreatePriceStorageOptions | undefined);
    }

    // 2. Adapters
    this.binanceAdapter = new BinanceAdapter({ transport });
    this.gateAdapter = new GateAdapter({ transport });
    const okxAdapter = new OkxAdapter({ transport });
    const coinbaseAdapter = new CoinbaseAdapter({ transport });
    const geckoAdapter = new GeckoTerminalAdapter({ transport });

    const adapters = options.priceAdapters ?? [
      this.binanceAdapter,
      this.gateAdapter,
      okxAdapter,
      coinbaseAdapter,
      geckoAdapter,
    ];

    // 3. Router & Executor
    this.router = new PriceProviderRouter(adapters);
    this.executor = new PriceRequestExecutor({
      configuration: {
        routeMode: "direct",
        totalTimeoutMs: options.timeoutMs ?? 30_000,
        attemptTimeoutMs: Math.min(10_000, options.timeoutMs ?? 30_000),
        maxProviderConcurrency: 3,
      },
    });
    this.priceAggregator = new TokenPriceAggregator(this.router, this.executor);

    // 4. Token support & klines
    this.tokenSupportStore = new TokenSupportStore(this.storage);
    this.tokenSupportService = new TokenSupportService(this.tokenSupportStore, { transport });
    this.klineArchiveManager = new KlineArchiveManager({
      cacheDir: options.cacheDir,
      storage: this.storage,
    });
    this.unifiedKlineService = new UnifiedKlineService(
      this.tokenSupportService,
      this.klineArchiveManager,
      this.binanceAdapter,
      this.gateAdapter,
      { transport },
    );

    // 5. Price sync
    const dailyAdapters = new Map<string, TokenPriceProviderAdapter>();
    for (const a of adapters) {
      dailyAdapters.set(a.name, a);
    }
    this.priceSyncService = new PriceSyncService(
      this.storage,
      this.binanceAdapter,
      this.tokenAliases,
      dailyAdapters,
    );
  }

  async initialize(): Promise<void> {
    await this.storage.initialize();
    await this.tokenSupportService.initialize();
  }

  async close(): Promise<void> {
    await this.storage.close();
  }

  // Price aggregation
  getPriceHistory(request: TokenPriceHistoryRequest): Promise<TokenPriceAggregationResult> {
    return this.priceAggregator.getPriceHistory(
      normalizeTokenPriceHistoryRequest(request, { aliases: this.tokenAliases }),
    );
  }

  // K-line services
  getKlines(request: KlineRequest): Promise<KlineResult> {
    return this.unifiedKlineService.getKlines(normalizeKlineRequest(request));
  }

  getKlinesPrices(request: KlineRequest): Promise<readonly KlinePoint[]> {
    return this.unifiedKlineService.getKlinesPrices(normalizeKlineRequest(request));
  }

  getBinanceKlines(request: BinanceFiveMinuteKlineRequest): Promise<BinanceFiveMinuteKlineResult> {
    const normalized = normalizeBinanceFiveMinuteKlineRequest(request);
    return this.binanceAdapter
      .getFiveMinuteKlines(
        normalized.symbol,
        normalized.startMs,
        normalized.endMs,
        {
          proxy: null,
          timeoutMs: 30_000,
          nowMs: Date.now(),
          correlationId: "binance-5m",
          ...(normalized.signal === undefined ? {} : { signal: normalized.signal }),
        },
        normalized.interval,
      )
      .then((points) =>
        Object.freeze({
          provider: "binance" as const,
          symbol: normalized.symbol,
          quoteAsset: "USDT" as const,
          interval: normalized.interval,
          start: new Date(normalized.startMs).toISOString(),
          end: new Date(normalized.endMs).toISOString(),
          points,
        }),
      );
  }

  // Token support
  isTokenSupported(token: string, provider: TokenSupportProvider, signal?: AbortSignal): Promise<boolean> {
    return this.tokenSupportService.isTokenSupported(token, provider, signal);
  }

  getTokenSupport(token: string, signal?: AbortSignal): Promise<TokenSupportStatusMap> {
    return this.tokenSupportService.getTokenSupport(token, signal);
  }

  getSupportedProviders(token: string, signal?: AbortSignal): Promise<readonly TokenSupportProvider[]> {
    return this.tokenSupportService.getSupportedProviders(token, signal);
  }

  preloadSupportedTokens(providers?: readonly TokenSupportProvider[]): Promise<void> {
    return this.tokenSupportService.preloadSupportedTokens(providers);
  }

  // Price sync
  updatePriceSync(request: PriceUpdateRequest): Promise<PriceUpdateResult> {
    return this.priceSyncService.update(request);
  }

  recollectPriceSync(request: PriceRecollectRequest): Promise<PriceUpdateResult & { operation: "recollect"; dryRun: boolean }> {
    return this.priceSyncService.recollect(request);
  }

  getPriceAt(query: PricePointQuery): Promise<PriceAtResult> {
    return this.priceSyncService.getPriceAt(query);
  }

  getPricesAt(queries: readonly PricePointQuery[]): Promise<readonly PriceAtResult[]> {
    return this.priceSyncService.getPricesAt(queries);
  }

  getSyncStatus(input: Pick<PriceUpdateRequest, "token" | "exchange" | "market" | "quote" | "quoteCurrency" | "interval">) {
    return this.priceSyncService.getSyncStatus(input);
  }

  resetPriceSync(input: PriceSyncScopeRequest): Promise<void> {
    return this.priceSyncService.resetPriceSync(input);
  }
}

export function createTokenPriceClient(options: TokenPriceClientOptions = {}): TokenPriceClient {
  return new TokenPriceClient(options);
}
