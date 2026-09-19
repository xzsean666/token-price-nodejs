import axios, { type AxiosInstance, type AxiosRequestConfig } from "axios";
import type { HttpRequest, HttpResponse, HttpTransport } from "./HttpTransport";
import { requestTimeout, tokenPriceError } from "../domain/errors";

export class AxiosHttpTransport implements HttpTransport {
  private readonly client: AxiosInstance;

  constructor(client?: AxiosInstance) {
    this.client = client ?? axios.create();
  }

  async request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
    const config: AxiosRequestConfig = {
      method: req.method,
      url: req.url,
      timeout: req.timeoutMs ?? 30_000,
      responseType: req.responseType ?? "json",
      validateStatus: () => true, // Don't throw on 4xx/5xx so callers can handle status
    };
    if (req.params !== undefined) config.params = req.params;
    if (req.headers !== undefined) config.headers = req.headers as Record<string, string>;
    if (req.body !== undefined) config.data = req.body;
    if (req.signal !== undefined) config.signal = req.signal;

    if (req.proxyUrl) {
      try {
        const parsed = new URL(req.proxyUrl);
        config.proxy = {
          protocol: parsed.protocol.replace(":", ""),
          host: parsed.hostname,
          port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
          ...(parsed.username ? { auth: { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) } } : {}),
        };
      } catch {
        // Invalid proxy url format
      }
    }

    try {
      const response = await this.client.request<T>(config);
      const headers: Record<string, string | undefined> = {};
      if (response.headers && typeof response.headers === "object") {
        for (const [k, v] of Object.entries(response.headers)) {
          headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : typeof v === "string" ? v : String(v ?? "");
        }
      }
      return {
        status: response.status,
        headers,
        body: response.data,
      };
    } catch (error: any) {
      if (axios.isCancel(error) || req.signal?.aborted) {
        throw tokenPriceError("REQUEST_ABORTED", "HTTP request was aborted.", { cause: error });
      }
      if (error.code === "ECONNABORTED" || error.message?.includes("timeout")) {
        throw requestTimeout(`HTTP request timed out after ${req.timeoutMs ?? 30_000}ms.`);
      }
      throw tokenPriceError("PROVIDER_UNAVAILABLE", error.message || "Network request failed.", { cause: error });
    }
  }
}
