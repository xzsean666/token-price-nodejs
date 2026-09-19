export type TokenPriceErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_REQUEST"
  | "UNSUPPORTED_OPERATION"
  | "RATE_LIMITED"
  | "REQUEST_TIMEOUT"
  | "REQUEST_ABORTED"
  | "NETWORK_ERROR"
  | "PROXY_ERROR"
  | "INVALID_PROVIDER_RESPONSE"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_STALLED"
  | "TOKEN_NOT_FOUND"
  | "TOKEN_AMBIGUOUS"
  | "MARKET_NOT_FOUND"
  | "HISTORY_NOT_AVAILABLE"
  | "PRICE_DATA_UNAVAILABLE"
  | "PRICE_RANGE_INVALID"
  | "PRICE_NOT_FOUND"
  | "SYNC_SCOPE_CONFLICT"
  | "STORAGE_ERROR"
  | "STORAGE_NOT_INITIALIZED"
  | "STORAGE_MIGRATION_FAILED";

export interface TokenPriceErrorOptions {
  readonly code: TokenPriceErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly provider?: string | null | undefined;
  readonly retryAfterMs?: number | null | undefined;
  readonly cause?: unknown | undefined;
}

export class TokenPriceError extends Error {
  readonly code: TokenPriceErrorCode;
  readonly retryable: boolean;
  readonly provider: string | null;
  readonly retryAfterMs: number | null;
  override readonly cause?: unknown;

  constructor(options: TokenPriceErrorOptions) {
    super(options.message);
    this.name = "TokenPriceError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.provider = options.provider ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// Backwards compatibility alias for EVM Data SDK consumers
export { TokenPriceError as EvmDataError };

export function tokenPriceError(
  code: TokenPriceErrorCode,
  message: string,
  options: { retryable?: boolean; provider?: string | null; cause?: unknown; retryAfterMs?: number | null } = {},
): TokenPriceError {
  return new TokenPriceError({
    code,
    message,
    retryable: options.retryable ?? false,
    provider: options.provider,
    cause: options.cause,
    retryAfterMs: options.retryAfterMs,
  });
}

export function invalidRequest(message: string): TokenPriceError {
  return new TokenPriceError({ code: "INVALID_REQUEST", message, retryable: false });
}

export function unsupportedOperation(message: string, provider?: string): TokenPriceError {
  return new TokenPriceError({ code: "UNSUPPORTED_OPERATION", message, retryable: false, provider });
}

export function rateLimited(message: string, provider?: string, retryAfterMs?: number | null): TokenPriceError {
  return new TokenPriceError({ code: "RATE_LIMITED", message, retryable: true, provider, retryAfterMs });
}

export function requestTimeout(message: string, provider?: string): TokenPriceError {
  return new TokenPriceError({ code: "REQUEST_TIMEOUT", message, retryable: true, provider });
}

export function networkError(message: string, provider?: string, cause?: unknown): TokenPriceError {
  return new TokenPriceError({ code: "NETWORK_ERROR", message, retryable: true, provider, cause });
}

export function proxyError(message: string, provider?: string, cause?: unknown): TokenPriceError {
  return new TokenPriceError({ code: "PROXY_ERROR", message, retryable: true, provider, cause });
}

export function invalidProviderResponse(message: string, provider?: string, cause?: unknown): TokenPriceError {
  return new TokenPriceError({ code: "INVALID_PROVIDER_RESPONSE", message, retryable: false, provider, cause });
}

export function providerUnavailable(message: string, provider?: string, cause?: unknown): TokenPriceError {
  return new TokenPriceError({ code: "PROVIDER_UNAVAILABLE", message, retryable: true, provider, cause });
}

export function storageError(codeOrMessage: string, messageOrCause?: unknown, cause?: unknown): TokenPriceError {
  if (typeof messageOrCause === "string") {
    return new TokenPriceError({
      code: "STORAGE_ERROR",
      message: `[${codeOrMessage}] ${messageOrCause}`,
      retryable: false,
      cause,
    });
  }
  return new TokenPriceError({
    code: "STORAGE_ERROR",
    message: codeOrMessage,
    retryable: false,
    cause: messageOrCause,
  });
}
