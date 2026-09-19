import { TokenPriceError, isTokenPriceError } from "../domain/errors";
import { isHttpTransportError } from "../transport/HttpTransport";
import type {
  TokenPriceAggregationResult,
  TokenPriceProviderFailure,
  TokenPriceProviderFailureCode,
  TokenPriceProviderResult,
} from "../domain/priceModels";
import type { NormalizedTokenPriceRequest } from "../domain/priceOperations";
import type { PriceProxyLease, TokenPriceProviderAdapter } from "../providers/TokenPriceProviderAdapter";

const MAX_PROVIDER_ATTEMPTS = 3;
const RETRYABLE_CODES = new Set<TokenPriceProviderFailureCode>([
  "RATE_LIMITED",
  "REQUEST_TIMEOUT",
  "NETWORK_ERROR",
  "PROXY_ERROR",
  "PROVIDER_UNAVAILABLE",
]);

export interface NormalizedPriceConfiguration {
  readonly routeMode: "direct" | "balanced" | "proxy-only";
  readonly totalTimeoutMs: number;
  readonly attemptTimeoutMs: number;
  readonly maxProviderConcurrency: number;
}

export interface PriceRequestExecutorOptions {
  readonly configuration: NormalizedPriceConfiguration;
  readonly proxies?: readonly { readonly url: string }[] | undefined;
  readonly proxyPool?: {
    acquire(): PriceProxyLease | null | undefined;
    report(lease: PriceProxyLease, outcome: "success" | "proxy_failure" | "neutral"): void;
  } | undefined;
  readonly clock?: { now(): number } | undefined;
  readonly wait?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  readonly correlationIdFactory?: (() => string) | undefined;
}

export class PriceRequestExecutor {
  private readonly proxyPool: PriceRequestExecutorOptions["proxyPool"] | null;
  private readonly clock: { now(): number };
  private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly correlationIdFactory: () => string;

  constructor(private readonly options: PriceRequestExecutorOptions) {
    this.proxyPool = options.proxyPool ?? null;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.wait =
      options.wait ??
      ((ms: number, signal?: AbortSignal) =>
        new Promise((resolve, reject) => {
          if (signal?.aborted) return reject(new Error("Aborted"));
          const timer = setTimeout(resolve, ms);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("Aborted"));
          });
        }));
    this.correlationIdFactory = options.correlationIdFactory ?? defaultUuid;
  }

  async execute(
    request: NormalizedTokenPriceRequest,
    adapters: readonly TokenPriceProviderAdapter[],
  ): Promise<TokenPriceAggregationResult> {
    if (request.signal !== undefined && request.signal.aborted) {
      throw callerAborted();
    }
    if (this.options.configuration.routeMode === "proxy-only" && (!this.options.proxies || this.options.proxies.length === 0)) {
      throw new TokenPriceError({
        code: "PROXY_ERROR",
        message: "Token price proxy-only mode requires a configured HTTP(S) proxy.",
        retryable: false,
      });
    }

    const deadline = this.clock.now() + this.options.configuration.totalTimeoutMs;
    const maxConcurrency =
      this.options.configuration.routeMode === "proxy-only"
        ? Math.min(this.options.configuration.maxProviderConcurrency, Math.max(1, this.options.proxies?.length ?? 1))
        : this.options.configuration.maxProviderConcurrency;

    const settled = await runBounded(adapters, maxConcurrency, async (adapter) =>
      this.executeProvider(adapter, request, deadline),
    );

    if (request.signal?.aborted === true) {
      throw callerAborted();
    }

    const results: TokenPriceProviderResult[] = [];
    const failures: TokenPriceProviderFailure[] = [];
    settled.forEach((outcome, index) => {
      const adapter = adapters[index];
      if (adapter === undefined) return;
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
      } else {
        failures.push(toProviderFailure(adapter.name, outcome.reason));
      }
    });

    if (results.length === 0) {
      const summary = failures.map((failure) => `${failure.provider}:${failure.code}`).join(", ");
      throw new TokenPriceError({
        code: "PRICE_DATA_UNAVAILABLE",
        message: summary === "" ? "Price data is unavailable." : `Price data is unavailable (${summary}).`,
        retryable: failures.some((failure) => failure.retryable),
      });
    }

    return Object.freeze({
      query: Object.freeze({
        tokenInput: request.tokenInput,
        normalizedToken: request.normalizedToken,
        interval: "1d",
        timezone: "UTC",
        range: request.range,
        resolvedStartDate: request.resolvedRange.startDate,
        resolvedEndDate: request.resolvedRange.endDate,
      }),
      results: Object.freeze(results),
      failures: Object.freeze(failures),
      summary: Object.freeze({
        requestedProviders: adapters.length,
        succeededProviders: results.length,
        failedProviders: failures.length,
        partial: failures.length > 0,
      }),
    });
  }

  private async executeProvider(
    adapter: TokenPriceProviderAdapter,
    request: NormalizedTokenPriceRequest,
    deadline: number,
  ): Promise<TokenPriceProviderResult> {
    let lastFailure: TokenPriceError | null = null;
    for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
      if (request.signal?.aborted === true) throw callerAborted(adapter.name);
      const remaining = deadline - this.clock.now();
      if (remaining <= 0) {
        throw new TokenPriceError({
          code: "REQUEST_TIMEOUT",
          message: "Token price request exceeded its deadline.",
          retryable: true,
          provider: adapter.name,
        });
      }

      const proxy = this.options.configuration.routeMode === "direct" ? null : this.proxyPool?.acquire();
      if (proxy === undefined && this.options.configuration.routeMode === "proxy-only") {
        throw new TokenPriceError({
          code: "PROXY_ERROR",
          message: "No configured proxy route is available for token prices.",
          retryable: false,
          provider: adapter.name,
        });
      }

      const startedAt = this.clock.now();
      try {
        const result = await adapter.getPriceHistory(request, {
          proxy: proxy ?? null,
          timeoutMs: Math.max(1, Math.min(this.options.configuration.attemptTimeoutMs, remaining)),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          correlationId: this.correlationIdFactory(),
          nowMs: startedAt,
        });
        if (proxy) this.proxyPool?.report(proxy, "success");
        return result;
      } catch (error: unknown) {
        const failure = normalizeAttemptFailure(error, adapter.name, request.signal);
        lastFailure = failure;
        if (proxy) {
          this.proxyPool?.report(proxy, failure.code === "PROXY_ERROR" ? "proxy_failure" : "neutral");
        }
        if (failure.code === "REQUEST_ABORTED") throw failure;
        if (
          !RETRYABLE_CODES.has(failure.code as TokenPriceProviderFailureCode) ||
          !failure.retryable ||
          attempt === MAX_PROVIDER_ATTEMPTS
        ) {
          throw failure;
        }
        const retryDelay = Math.min(
          Math.max(0, failure.retryAfterMs ?? 0, 100 * (2 ** (attempt - 1))),
          Math.max(0, deadline - this.clock.now()),
        );
        if (retryDelay <= 0 || this.clock.now() + retryDelay >= deadline) throw failure;
        await this.wait(retryDelay, request.signal);
      }
    }
    throw (
      lastFailure ??
      new TokenPriceError({
        code: "PROVIDER_UNAVAILABLE",
        message: "Token price provider did not complete.",
        retryable: true,
        provider: adapter.name,
      })
    );
  }
}

function defaultUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function normalizeAttemptFailure(error: unknown, provider: string, signal: AbortSignal | undefined): TokenPriceError {
  if (signal?.aborted === true) return callerAborted(provider);
  if (isTokenPriceError(error)) return error;
  if (isHttpTransportError(error)) {
    return new TokenPriceError({
      code: error.code as any,
      message: "Token price HTTP request failed.",
      retryable: error.retryable,
      provider,
    });
  }
  return new TokenPriceError({
    code: "PROVIDER_UNAVAILABLE",
    message: "Token price provider request failed.",
    retryable: true,
    provider,
    cause: error,
  });
}

function toProviderFailure(
  provider: TokenPriceProviderFailure["provider"],
  error: unknown,
): TokenPriceProviderFailure {
  const normalized = normalizeAttemptFailure(error, provider, undefined);
  const code: TokenPriceProviderFailureCode = isProviderFailureCode(normalized.code)
    ? (normalized.code as TokenPriceProviderFailureCode)
    : "PROVIDER_UNAVAILABLE";
  return Object.freeze({
    provider,
    code,
    retryable: normalized.retryable,
    message: providerFailureMessage(code),
  });
}

function isProviderFailureCode(value: string): value is TokenPriceProviderFailureCode {
  return (
    value === "TOKEN_NOT_FOUND" ||
    value === "TOKEN_AMBIGUOUS" ||
    value === "MARKET_NOT_FOUND" ||
    value === "HISTORY_NOT_AVAILABLE" ||
    value === "RATE_LIMITED" ||
    value === "REQUEST_TIMEOUT" ||
    value === "NETWORK_ERROR" ||
    value === "PROXY_ERROR" ||
    value === "INVALID_PROVIDER_RESPONSE" ||
    value === "PROVIDER_UNAVAILABLE"
  );
}

function callerAborted(provider?: string): TokenPriceError {
  return new TokenPriceError({
    code: "REQUEST_ABORTED",
    message: "Token price request was aborted.",
    retryable: false,
    ...(provider === undefined ? {} : { provider }),
  });
}

function providerFailureMessage(code: TokenPriceProviderFailureCode): string {
  switch (code) {
    case "TOKEN_NOT_FOUND":
      return "The token was not found by this provider.";
    case "TOKEN_AMBIGUOUS":
      return "The token could not be resolved unambiguously by this provider.";
    case "MARKET_NOT_FOUND":
      return "The required active Spot market was not found by this provider.";
    case "HISTORY_NOT_AVAILABLE":
      return "The requested daily history is not available from this provider.";
    case "RATE_LIMITED":
      return "The provider rate limit was reached.";
    case "REQUEST_TIMEOUT":
      return "The provider request timed out.";
    case "NETWORK_ERROR":
      return "The provider network request failed.";
    case "PROXY_ERROR":
      return "The configured proxy route failed.";
    case "INVALID_PROVIDER_RESPONSE":
      return "The provider returned an invalid response.";
    case "PROVIDER_UNAVAILABLE":
      return "The provider is temporarily unavailable.";
  }
}

async function runBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<readonly PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value === undefined) return;
      try {
        results[index] = { status: "fulfilled", value: await operation(value) };
      } catch (reason: unknown) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, values.length)) }, worker));
  return results;
}
