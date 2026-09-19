import { TokenPriceError } from "../../domain/errors";
import type { HttpResponse } from "../../transport/HttpTransport";
import { isHttpTransportError } from "../../transport/HttpTransport";

export function classifyGateResponse(response: HttpResponse): TokenPriceError | null {
  if (response.status >= 200 && response.status < 300) return null;
  if (response.status === 404) return error("MARKET_NOT_FOUND", "Gate Spot USDT market was not found.", false);
  if (response.status === 429) return error("RATE_LIMITED", "Gate rate limit was reached.", true, retryAfter(response));
  if (response.status === 408) return error("REQUEST_TIMEOUT", "Gate request timed out.", true);
  if (response.status >= 500 && response.status <= 599) return error("PROVIDER_UNAVAILABLE", "Gate is temporarily unavailable.", true, retryAfter(response));
  return error("INVALID_PROVIDER_RESPONSE", "Gate returned an unexpected HTTP response.", false);
}

export function normalizeGateTransportError(value: unknown): TokenPriceError | null {
  if (!isHttpTransportError(value)) return null;
  const message =
    value.code === "REQUEST_TIMEOUT"
      ? "Gate request timed out."
      : value.code === "PROXY_ERROR"
        ? "Gate request failed at the proxy boundary."
        : value.code === "REQUEST_ABORTED"
          ? "Gate request was aborted."
          : "Gate network request failed.";
  return error(value.code as any, message, value.retryable);
}

function error(code: TokenPriceError["code"], message: string, retryable: boolean, retryAfterMs?: number): TokenPriceError {
  return new TokenPriceError({ code, message, retryable, provider: "gate", ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
}

function retryAfter(response: HttpResponse): number | undefined {
  const value = Object.entries(response.headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
  const raw = Array.isArray(value) ? value[0] : value;
  const seconds = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1_000) : undefined;
}
