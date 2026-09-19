import { TokenPriceError } from "../../domain/errors";
import type { HttpResponse } from "../../transport/HttpTransport";
import { isHttpTransportError } from "../../transport/HttpTransport";

export function classifyCoinbaseResponse(response: HttpResponse): TokenPriceError | null {
  if (response.status >= 200 && response.status < 300) return null;
  if (response.status === 404) return failure("MARKET_NOT_FOUND", "Coinbase active Spot USD market was not found.", false);
  if (response.status === 429) return failure("RATE_LIMITED", "Coinbase rate limit was reached.", true, retryAfter(response));
  if (response.status === 408) return failure("REQUEST_TIMEOUT", "Coinbase request timed out.", true);
  if (response.status >= 500 && response.status <= 599) return failure("PROVIDER_UNAVAILABLE", "Coinbase is temporarily unavailable.", true, retryAfter(response));
  return failure("INVALID_PROVIDER_RESPONSE", "Coinbase returned an unexpected HTTP response.", false);
}

export function normalizeCoinbaseTransportError(value: unknown): TokenPriceError | null {
  if (!isHttpTransportError(value)) return null;
  const message =
    value.code === "REQUEST_TIMEOUT"
      ? "Coinbase request timed out."
      : value.code === "PROXY_ERROR"
        ? "Coinbase request failed at the proxy boundary."
        : value.code === "REQUEST_ABORTED"
          ? "Coinbase request was aborted."
          : "Coinbase network request failed.";
  return failure(value.code as any, message, value.retryable);
}

function failure(code: TokenPriceError["code"], message: string, retryable: boolean, retryAfterMs?: number): TokenPriceError {
  return new TokenPriceError({ code, message, retryable, provider: "coinbase", ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
}

function retryAfter(response: HttpResponse): number | undefined {
  const value = Object.entries(response.headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
  const raw = Array.isArray(value) ? value[0] : value;
  const seconds = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1_000) : undefined;
}
