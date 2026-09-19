import type { HttpTransport } from "../transport/HttpTransport";
import { AxiosHttpTransport } from "../transport/AxiosHttpTransport";
import type { TokenSupportProvider, TokenSupportStatusMap } from "../domain/tokenSupportModels";
import type { TokenSupportStoreInterface } from "../storage/PriceStorage";

export interface TokenSupportServiceOptions {
  readonly transport?: HttpTransport | undefined;
  readonly binanceBaseUrl?: string | undefined;
  readonly gateBaseUrl?: string | undefined;
}

export class TokenSupportService {
  private readonly transport: HttpTransport;
  private readonly binanceBaseUrl: string;
  private readonly gateBaseUrl: string;
  private readonly cache = new Map<string, Map<TokenSupportProvider, boolean>>();
  private initialized = false;

  constructor(
    private readonly store: TokenSupportStoreInterface,
    options: TokenSupportServiceOptions = {},
  ) {
    this.transport = options.transport ?? new AxiosHttpTransport();
    this.binanceBaseUrl = (options.binanceBaseUrl ?? "https://api.binance.com").replace(/\/$/, "");
    this.gateBaseUrl = (options.gateBaseUrl ?? "https://api.gateio.ws").replace(/\/$/, "");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const records = await this.store.loadAll();
    for (const record of records) {
      this.setMemoryCache(record.token, record.provider, record.supported);
    }
    this.initialized = true;
  }

  /**
   * Preloads all spot symbols from Binance and Gate into memory and storage.
   * This allows O(1) in-memory checks for thousands of tokens.
   */
  async preloadSupportedTokens(providers: readonly TokenSupportProvider[] = ["binance", "gate"]): Promise<void> {
    await this.initialize();
    const tasks: Promise<void>[] = [];

    if (providers.includes("binance")) {
      tasks.push(
        (async () => {
          try {
            const res = await this.transport.request({
              method: "GET",
              url: `${this.binanceBaseUrl}/api/v3/exchangeInfo?permissions=SPOT`,
              timeoutMs: 5000,
            });
            if (res.status === 200 && res.body && typeof res.body === "object") {
              const symbols = (
                res.body as {
                  symbols?: Array<{ symbol?: string; status?: string; isSpotTradingAllowed?: boolean }>;
                }
              ).symbols;
              if (Array.isArray(symbols)) {
                for (const s of symbols) {
                  if (
                    typeof s.symbol === "string" &&
                    s.symbol.endsWith("USDT") &&
                    s.status === "TRADING" &&
                    s.isSpotTradingAllowed !== false
                  ) {
                    const token = s.symbol.slice(0, -4);
                    this.setMemoryCache(token, "binance", true);
                    this.store.set(token, "binance", true);
                  }
                }
              }
            }
          } catch {
            // Preload is best-effort
          }
        })(),
      );
    }

    if (providers.includes("gate")) {
      tasks.push(
        (async () => {
          try {
            const res = await this.transport.request({
              method: "GET",
              url: `${this.gateBaseUrl}/api/v4/spot/currency_pairs`,
              timeoutMs: 5000,
            });
            if (res.status === 200 && Array.isArray(res.body)) {
              for (const p of res.body as Array<{ id?: string; trade_status?: string }>) {
                if (typeof p.id === "string" && p.id.endsWith("_USDT") && p.trade_status === "tradable") {
                  const token = p.id.slice(0, -5);
                  this.setMemoryCache(token, "gate", true);
                  this.store.set(token, "gate", true);
                }
              }
            }
          } catch {
            // Preload is best-effort
          }
        })(),
      );
    }

    await Promise.all(tasks);
  }

  /**
   * Checks whether a specific provider supports the token.
   * Checks: Memory -> Storage -> Upstream (with strict 1s timeout).
   * Timeouts and uncertain responses are NOT cached to storage.
   */
  async isTokenSupported(token: string, provider: TokenSupportProvider, signal?: AbortSignal): Promise<boolean> {
    await this.initialize();
    const cleanToken = normalizeToken(token);
    if (!cleanToken) return false;

    // 1. Check in-memory cache
    const providerMap = this.cache.get(cleanToken);
    if (providerMap !== undefined && providerMap.has(provider)) {
      return providerMap.get(provider)!;
    }

    // 2. Check storage
    const persisted = await this.store.get(cleanToken, provider);
    if (persisted !== null) {
      this.setMemoryCache(cleanToken, provider, persisted.supported);
      return persisted.supported;
    }

    // 3. Probe upstream with 1s timeout
    if (provider === "binance") {
      return this.probeBinance(cleanToken, signal);
    } else {
      return this.probeGate(cleanToken, signal);
    }
  }

  /**
   * Returns a map of provider -> support status for the given token.
   */
  async getTokenSupport(token: string, signal?: AbortSignal): Promise<TokenSupportStatusMap> {
    const [binance, gate] = await Promise.all([
      this.isTokenSupported(token, "binance", signal).catch(() => false),
      this.isTokenSupported(token, "gate", signal).catch(() => false),
    ]);
    return { binance, gate };
  }

  /**
   * Returns a list of providers that definitively support the given token.
   */
  async getSupportedProviders(token: string, signal?: AbortSignal): Promise<readonly TokenSupportProvider[]> {
    const support = await this.getTokenSupport(token, signal);
    const result: TokenSupportProvider[] = [];
    if (support.binance) result.push("binance");
    if (support.gate) result.push("gate");
    return Object.freeze(result);
  }

  private async probeBinance(token: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await this.transport.request({
        method: "GET",
        url: `${this.binanceBaseUrl}/api/v3/exchangeInfo`,
        params: { symbol: `${token}USDT` },
        timeoutMs: 1000,
        ...(signal === undefined ? {} : { signal }),
      });

      if (response.status === 200 && response.body && typeof response.body === "object") {
        const symbols = (
          response.body as {
            symbols?: Array<{ symbol?: string; status?: string; isSpotTradingAllowed?: boolean }>;
          }
        ).symbols;
        const market = symbols?.find(
          (s) => s.symbol === `${token}USDT` && s.status === "TRADING" && s.isSpotTradingAllowed !== false,
        );
        const supported = market !== undefined;
        this.setMemoryCache(token, "binance", supported);
        this.store.set(token, "binance", supported);
        return supported;
      }

      if (response.status === 400) {
        // Invalid symbol is a definitive negative answer
        this.setMemoryCache(token, "binance", false);
        this.store.set(token, "binance", false);
        return false;
      }

      // Any other status: uncertain, DO NOT save to storage
      return false;
    } catch (error: any) {
      if (error?.response?.status === 400 || error?.status === 400) {
        this.setMemoryCache(token, "binance", false);
        this.store.set(token, "binance", false);
        return false;
      }
      return false;
    }
  }

  private async probeGate(token: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await this.transport.request({
        method: "GET",
        url: `${this.gateBaseUrl}/api/v4/spot/currency_pairs/${token}_USDT`,
        timeoutMs: 1000,
        ...(signal === undefined ? {} : { signal }),
      });

      if (response.status === 200 && response.body && typeof response.body === "object") {
        const pair = response.body as { id?: string; trade_status?: string };
        const supported = pair.trade_status === "tradable";
        this.setMemoryCache(token, "gate", supported);
        this.store.set(token, "gate", supported);
        return supported;
      }

      if (response.status === 404) {
        this.setMemoryCache(token, "gate", false);
        this.store.set(token, "gate", false);
        return false;
      }

      return false;
    } catch (error: any) {
      if (error?.response?.status === 404 || error?.status === 404) {
        this.setMemoryCache(token, "gate", false);
        this.store.set(token, "gate", false);
        return false;
      }
      return false;
    }
  }

  private setMemoryCache(token: string, provider: TokenSupportProvider, supported: boolean): void {
    let providerMap = this.cache.get(token);
    if (providerMap === undefined) {
      providerMap = new Map();
      this.cache.set(token, providerMap);
    }
    providerMap.set(provider, supported);
  }
}

function normalizeToken(token: string): string {
  const cleaned = token.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.endsWith("USDT") && cleaned.length > 4) {
    return cleaned.slice(0, -4);
  }
  return cleaned;
}
