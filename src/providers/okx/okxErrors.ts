import { TokenPriceError } from "../../domain/errors";
import type { HttpResponse } from "../../transport/HttpTransport";
import { isHttpTransportError } from "../../transport/HttpTransport";

export function classifyOkxResponse(response: HttpResponse): TokenPriceError | null {
  if (response.status >= 200 && response.status < 300) return null;
  if (response.status === 429) return error("RATE_LIMITED", "OKX rate limit was reached.", true);
  if (response.status === 408) return error("REQUEST_TIMEOUT", "OKX request timed out.", true);
  if (response.status >= 500 && response.status <= 599) return error("PROVIDER_UNAVAILABLE", "OKX is temporarily unavailable.", true);
  return error("INVALID_PROVIDER_RESPONSE", "OKX returned an unexpected HTTP response.", false);
}

export function normalizeOkxTransportError(value: unknown): TokenPriceError | null {
  if (!isHttpTransportError(value)) return null;
  const message =
    value.code === "REQUEST_TIMEOUT"
      ? "OKX request timed out."
      : value.code === "PROXY_ERROR"
        ? "OKX request failed at the proxy boundary."
        : value.code === "REQUEST_ABORTED"
          ? "OKX request was aborted."
          : "OKX network request failed.";
  return error(value.code as any, message, value.retryable);
}

export function classifyOkxEnvelope(code: string, message: string | undefined): TokenPriceError | null {
  if (code === "0") return null;
  if (/instrument|instId|not found/i.test(message ?? "")) return error("MARKET_NOT_FOUND", "OKX active Spot USDT market was not found.", false);
  if (/rate|too many/i.test(message ?? "")) return error("RATE_LIMITED", "OKX rate limit was reached.", true);
  return error("PROVIDER_UNAVAILABLE", "OKX rejected the request.", false);
}

function error(code: TokenPriceError["code"], message: string, retryable: boolean): TokenPriceError {
  return new TokenPriceError({ code, message, retryable, provider: "okx" });
}
