import type { HttpRequest, HttpResponse, HttpTransport } from "./HttpTransport";
import { requestTimeout, tokenPriceError } from "../domain/errors";

export class FetchHttpTransport implements HttpTransport {
  async request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
    let url = req.url;
    if (req.params) {
      const parsedUrl = new URL(url);
      for (const [k, v] of Object.entries(req.params)) {
        if (v !== undefined && v !== null) {
          parsedUrl.searchParams.set(k, String(v));
        }
      }
      url = parsedUrl.toString();
    }

    const headers = new Headers();
    if (req.headers) {
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined && v !== null) {
          headers.set(k, v);
        }
      }
    }

    let signal = req.signal;
    let timeoutId: any;
    let onAbort: (() => void) | undefined;
    if (req.timeoutMs && req.timeoutMs > 0) {
      const controller = new AbortController();
      if (signal) {
        onAbort = () => controller.abort(signal?.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      }
      timeoutId = setTimeout(() => controller.abort(new Error("Timeout")), req.timeoutMs);
      signal = controller.signal;
    }

    const init: RequestInit = {
      method: req.method,
      headers,
    };
    if (req.body !== undefined && req.body !== null) {
      init.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    }
    if (signal !== undefined) {
      init.signal = signal;
    }

    try {
      const response = await fetch(url, init);

      const resHeaders: Record<string, string | undefined> = {};
      response.headers.forEach((v, k) => {
        resHeaders[k.toLowerCase()] = v;
      });

      let body: any;
      if (req.responseType === "arraybuffer") {
        body = await response.arrayBuffer();
      } else if (req.responseType === "text") {
        body = await response.text();
      } else {
        const text = await response.text();
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }

      return {
        status: response.status,
        headers: resHeaders,
        body,
      };
    } catch (error: any) {
      if (signal?.aborted) {
        if (signal.reason instanceof Error && signal.reason.message === "Timeout") {
          throw requestTimeout(`Fetch timed out after ${req.timeoutMs}ms.`);
        }
        throw tokenPriceError("REQUEST_ABORTED", "Fetch request was aborted.", { cause: error });
      }
      throw tokenPriceError("PROVIDER_UNAVAILABLE", error.message || "Fetch network error.", { cause: error });
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (req.signal && onAbort) {
        req.signal.removeEventListener("abort", onAbort);
      }
    }
  }
}
