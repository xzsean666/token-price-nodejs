export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export interface HttpProxy {
  readonly protocol: "http" | "https";
  readonly host: string;
  readonly port: number;
  readonly auth?: {
    readonly username: string;
    readonly password: string;
  } | undefined;
}

export type HttpParameterValue = string | number | boolean | null | undefined;

export interface HttpRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string | undefined>> | undefined;
  readonly params?: Readonly<Record<string, HttpParameterValue>> | undefined;
  readonly body?: unknown | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly proxy?: HttpProxy | null | undefined;
  readonly proxyUrl?: string | null | undefined;
  readonly responseType?: "json" | "arraybuffer" | "text" | undefined;
}

export interface HttpResponse<T = any> {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: T;
}

export type TransportErrorCode =
  | "INVALID_REQUEST"
  | "REQUEST_TIMEOUT"
  | "REQUEST_ABORTED"
  | "NETWORK_ERROR"
  | "PROXY_ERROR";

export interface HttpTransportErrorOptions {
  readonly code: TransportErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly status?: number | null | undefined;
  readonly cause?: unknown | undefined;
}

export class HttpTransportError extends Error {
  readonly code: TransportErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;
  override readonly cause: unknown;

  constructor(options: HttpTransportErrorOptions) {
    if ("cause" in options) {
      super(options.message, { cause: options.cause });
    } else {
      super(options.message);
    }

    this.name = "HttpTransportError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status ?? null;
    this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isHttpTransportError(value: unknown): value is HttpTransportError {
  return (
    value instanceof HttpTransportError ||
    (typeof value === "object" &&
      value !== null &&
      "code" in value &&
      "retryable" in value &&
      (value as any).name === "HttpTransportError")
  );
}

export function parseHttpProxyUrl(rawUrl: string): HttpProxy {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("HTTP proxy URL must use http: or https: scheme.");
  }
  return {
    protocol: parsed.protocol.slice(0, -1) as "http" | "https",
    host: parsed.hostname,
    port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
    ...(parsed.username ? { auth: { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) } } : {}),
  };
}

export interface HttpTransport {
  request(request: HttpRequest): Promise<HttpResponse<any>>;
}
