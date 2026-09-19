import { describe, expect, it } from "vitest";
import { MemoryPriceStorage, SqlitePriceStorage } from "../src/storage";
import { TokenSupportStore } from "../src/services/TokenSupportStore";
import { TokenSupportService } from "../src/services/TokenSupportService";
import type { HttpTransport, HttpRequest, HttpResponse } from "../src/transport/HttpTransport";

class MockHttpTransport implements HttpTransport {
  constructor(private readonly handler: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>) {}
  async request(req: HttpRequest): Promise<HttpResponse> {
    return this.handler(req);
  }
}

describe("TokenSupportStore & TokenSupportService", () => {
  it("persists and retrieves token support from SQLite", async () => {
    const storage = new SqlitePriceStorage({ path: ":memory:" });
    await storage.initialize();
    const store = new TokenSupportStore(storage);

    store.set("BTC", "binance", true);
    store.set("ETH", "gate", true);
    store.set("SCAM", "binance", false);

    const btc = await store.get("BTC", "binance");
    expect(btc).toEqual({
      token: "BTC",
      provider: "binance",
      supported: true,
      updatedAt: expect.any(String),
    });

    const scam = await store.get("SCAM", "binance");
    expect(scam?.supported).toBe(false);

    const all = await store.loadAll();
    expect(all.length).toBe(3);

    await storage.close();
  });

  it("checks support with memory -> sqlite -> 1s probe flow", async () => {
    const storage = new MemoryPriceStorage();
    await storage.initialize();
    const store = new TokenSupportStore(storage);

    let probeCount = 0;
    const transport = new MockHttpTransport((req) => {
      probeCount++;
      if (req.url.includes("api.binance.com/api/v3/exchangeInfo")) {
        const symbol = req.params?.symbol;
        if (symbol === "BTCUSDT") {
          return {
            status: 200,
            headers: {},
            body: {
              symbols: [{ symbol: "BTCUSDT", status: "TRADING", isSpotTradingAllowed: true }],
            },
          };
        }
        if (symbol === "INVALIDUSDT") {
          return {
            status: 400,
            headers: {},
            body: { code: -1121, msg: "Invalid symbol." },
          };
        }
      }
      if (req.url.includes("api.gateio.ws/api/v4/spot/currency_pairs/ETH_USDT")) {
        return {
          status: 200,
          headers: {},
          body: { id: "ETH_USDT", trade_status: "tradable" },
        };
      }
      if (req.url.includes("api.gateio.ws/api/v4/spot/currency_pairs/UNKNOWN_USDT")) {
        return {
          status: 404,
          headers: {},
          body: { label: "CURRENCY_PAIR_NOT_FOUND" },
        };
      }
      return { status: 500, headers: {}, body: {} };
    });

    const service = new TokenSupportService(store, { transport });
    await service.initialize();

    // 1. First probe for BTC on Binance -> true
    const btcSupported = await service.isTokenSupported("BTC", "binance");
    expect(btcSupported).toBe(true);
    expect(probeCount).toBe(1);

    // Second check should hit memory cache (probeCount unchanged)
    const btcAgain = await service.isTokenSupported("BTC", "binance");
    expect(btcAgain).toBe(true);
    expect(probeCount).toBe(1);

    // Verify written to store
    const persistedBtc = await store.get("BTC", "binance");
    expect(persistedBtc?.supported).toBe(true);

    // 2. Probe for INVALID on Binance -> false (definite 400)
    const invalidSupported = await service.isTokenSupported("INVALID", "binance");
    expect(invalidSupported).toBe(false);
    expect(probeCount).toBe(2);

    const persistedInvalid = await store.get("INVALID", "binance");
    expect(persistedInvalid?.supported).toBe(false);

    // 3. Probe Gate for ETH -> true
    const ethGate = await service.isTokenSupported("ETH", "gate");
    expect(ethGate).toBe(true);

    // 4. Probe Gate for UNKNOWN -> false (definite 404)
    const unknownGate = await service.isTokenSupported("UNKNOWN", "gate");
    expect(unknownGate).toBe(false);
  });

  it("does NOT cache timeouts or 5xx uncertain responses to store", async () => {
    const storage = new MemoryPriceStorage();
    await storage.initialize();
    const store = new TokenSupportStore(storage);

    const transport = new MockHttpTransport(() => {
      throw new Error("Request timeout exceeded 1000ms");
    });

    const service = new TokenSupportService(store, { transport });
    await service.initialize();

    const supported = await service.isTokenSupported("TIMEOUT_TOKEN", "binance");
    expect(supported).toBe(false);

    // MUST NOT be saved to store
    const persisted = await store.get("TIMEOUT_TOKEN", "binance");
    expect(persisted).toBeNull();
  });
});
