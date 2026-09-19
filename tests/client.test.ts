import { describe, expect, it } from "vitest";
import { TokenPriceClient } from "../src/client/TokenPriceClient";
import { MemoryPriceStorage } from "../src/storage/MemoryPriceStorage";
import type { HttpTransport, HttpRequest, HttpResponse } from "../src/transport/HttpTransport";

class MockHttpTransport implements HttpTransport {
  constructor(private readonly handler: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>) {}
  async request(req: HttpRequest): Promise<HttpResponse> {
    return this.handler(req);
  }
}

describe("TokenPriceClient", () => {
  it("initializes with default in-memory storage and checks token support", async () => {
    const transport = new MockHttpTransport((req) => {
      if (req.url.includes("binance.com/api/v3/exchangeInfo")) {
        return {
          status: 200,
          headers: {},
          body: { symbols: [{ symbol: "BTCUSDT", status: "TRADING", isSpotTradingAllowed: true }] },
        };
      }
      return { status: 404, headers: {}, body: {} };
    });

    const client = new TokenPriceClient({
      storage: new MemoryPriceStorage(),
      transport,
    });

    await client.initialize();

    const isSupported = await client.isTokenSupported("BTC", "binance");
    expect(isSupported).toBe(true);

    const supportMap = await client.getTokenSupport("BTC");
    expect(supportMap.binance).toBe(true);
    expect(supportMap.gate).toBe(false);

    await client.close();
  });

  it("handles price sync queries when initialized", async () => {
    const storage = new MemoryPriceStorage();
    const client = new TokenPriceClient({ storage });
    await client.initialize();

    // Save points using standard scope key: "eth:binance:SPOT:USDT:5m"
    const scopeKey = "eth:binance:SPOT:USDT:5m";
    await storage.priceSync.savePoints(scopeKey, [
      { timestamp: "2026-01-01T12:00:00.000Z", payload: { price: "3200.5" } },
    ]);

    const result = await client.getPriceAt({
      token: "ETH",
      exchange: "binance",
      quote: "USDT",
      market: "SPOT",
      timestamp: "2026-01-01T12:00:00.000Z",
      direction: "nearest",
    });

    expect(result.status).toBe("priced");
    expect(result.price).toBe("3200.5");
    expect(result.priceTimestamp).toBe("2026-01-01T12:00:00.000Z");

    await client.close();
  });
});
