import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach } from "vitest";
import {
  createPriceStorage,
  IndexedDbPriceStorage,
  MemoryPriceStorage,
  SqlitePriceStorage,
  type PriceStorage,
} from "../src/storage";
import { KlineBinaryCodec } from "../src/archive/KlineBinaryCodec";

function runStorageTestSuite(name: string, getStorage: () => Promise<PriceStorage>) {
  describe(`PriceStorage: ${name}`, () => {
    let storage: PriceStorage;

    beforeEach(async () => {
      storage = await getStorage();
      await storage.initialize();
    });

    it("handles token support records", async () => {
      await storage.tokenSupport.set("BTC", "binance", true);
      await storage.tokenSupport.set("ETH", "gate", true);
      await storage.tokenSupport.set("DODGE", "binance", false);

      const btc = await storage.tokenSupport.get("BTC", "binance");
      expect(btc).not.toBeNull();
      expect(btc?.token).toBe("BTC");
      expect(btc?.provider).toBe("binance");
      expect(btc?.supported).toBe(true);

      const dodge = await storage.tokenSupport.get("DODGE", "binance");
      expect(dodge?.supported).toBe(false);

      const nonExistent = await storage.tokenSupport.get("UNKNOWN", "binance");
      expect(nonExistent).toBeNull();

      const all = await storage.tokenSupport.loadAll();
      expect(all.length).toBe(3);
    });

    it("handles sync scopes and checkpoints", async () => {
      await storage.priceSync.setScope(
        "binance:BTC/USDT",
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z"
      );

      const scope = await storage.priceSync.getScope("binance:BTC/USDT");
      expect(scope).not.toBeNull();
      expect(scope?.scope_key).toBe("binance:BTC/USDT");
      expect(scope?.next_from).toBe("2026-01-01T00:00:00.000Z");
      expect(scope?.target_to).toBe("2026-01-02T00:00:00.000Z");

      const missing = await storage.priceSync.getScope("non:existent");
      expect(missing).toBeNull();

      await storage.priceSync.deleteScope("binance:BTC/USDT");
      const deleted = await storage.priceSync.getScope("binance:BTC/USDT");
      expect(deleted).toBeNull();
    });

    it("handles archive binary cache", async () => {
      const points = [
        { timestamp: 1700000000000, priceUsd: "50000.5" },
        { timestamp: 1700000060000, priceUsd: "50010.0" },
        { timestamp: 1700000120000, priceUsd: "50020.25" },
      ];
      const binaryData = KlineBinaryCodec.encode(points);
      const cacheKey = "binance:BTCUSDT:2026-01";

      await storage.archiveCache.setArchive(cacheKey, binaryData);

      const loaded = await storage.archiveCache.getArchive(cacheKey);
      expect(loaded).not.toBeNull();
      expect(loaded?.length).toBe(binaryData.length);

      const decoded = KlineBinaryCodec.decode(loaded!);
      expect(decoded.length).toBe(3);
      expect(decoded[0]?.timestamp).toBe(1700000000000);

      // Clean expired with 0 ttl -> should remove it
      await storage.archiveCache.cleanExpired(0);
      const expired = await storage.archiveCache.getArchive(cacheKey);
      expect(expired).toBeNull();
    });

    it("handles price points persistence and directional queries", async () => {
      const scopeKey = "binance:ETH/USDT";
      const points = [
        { timestamp: "2026-01-01T00:00:00.000Z", payload: { price: "3000.0" } },
        { timestamp: "2026-01-01T00:01:00.000Z", payload: { price: "3010.0" } },
        { timestamp: "2026-01-01T00:02:00.000Z", payload: { price: "3020.0" } },
      ];

      await storage.priceSync.savePoints(scopeKey, points);

      // Query exact timestamp with nearest
      const exact = await storage.priceSync.queryPoint({
        tokenKey: "ETH",
        scopeKey,
        timestamp: "2026-01-01T00:01:00.000Z",
        direction: "nearest",
      });
      expect(exact).not.toBeNull();
      expect(exact?.timestamp).toBe("2026-01-01T00:01:00.000Z");
      expect(exact?.payload).toEqual({ price: "3010.0" });

      // Query before (between 00:01 and 00:02) -> should return 00:01
      const before = await storage.priceSync.queryPoint({
        tokenKey: "ETH",
        scopeKey,
        timestamp: "2026-01-01T00:01:30.000Z",
        direction: "before",
      });
      expect(before?.timestamp).toBe("2026-01-01T00:01:00.000Z");

      // Query after (between 00:01 and 00:02) -> should return 00:02
      const after = await storage.priceSync.queryPoint({
        tokenKey: "ETH",
        scopeKey,
        timestamp: "2026-01-01T00:01:30.000Z",
        direction: "after",
      });
      expect(after?.timestamp).toBe("2026-01-01T00:02:00.000Z");

      // Query with maxDistanceMs exceeded
      const outOfRange = await storage.priceSync.queryPoint({
        tokenKey: "ETH",
        scopeKey,
        timestamp: "2026-01-01T00:01:30.000Z",
        direction: "before",
        maxDistanceMs: 5_000, // 5 seconds max distance, but difference is 30s
      });
      expect(outOfRange).toBeNull();

      // Delete point at 00:00:00 (half-open [00:00, 00:01))
      await storage.priceSync.deletePoints(scopeKey, "2026-01-01T00:00:00.000Z", "2026-01-01T00:01:00.000Z");
      const remainingNear = await storage.priceSync.queryPoint({
        tokenKey: "ETH",
        scopeKey,
        timestamp: "2026-01-01T00:00:00.000Z",
        direction: "nearest",
        maxDistanceMs: 10_000,
      });
      expect(remainingNear).toBeNull();

      // Delete all remaining points for scope
      await storage.priceSync.deletePoints(scopeKey);
      const allDeleted = await storage.priceSync.queryPoint({
        tokenKey: "ETH",
        scopeKey,
        timestamp: "2026-01-01T00:02:00.000Z",
        direction: "nearest",
      });
      expect(allDeleted).toBeNull();
    });
  });
}

// Test all 3 storage drivers: In-Memory, SQLite, IndexedDB
runStorageTestSuite("MemoryPriceStorage", async () => new MemoryPriceStorage());
runStorageTestSuite("SqlitePriceStorage (:memory:)", async () => new SqlitePriceStorage({ path: ":memory:" }));
runStorageTestSuite("IndexedDbPriceStorage (fake-indexeddb)", async () => new IndexedDbPriceStorage({ dbName: `test-db-${Math.random()}` }));

describe("createPriceStorage factory", () => {
  it("defaults to memory when requested", () => {
    const storage = createPriceStorage({ driver: "memory" });
    expect(storage.driver).toBe("memory");
  });

  it("creates sqlite storage when requested", () => {
    const storage = createPriceStorage({ driver: "sqlite", sqlite: { path: ":memory:" } });
    expect(storage.driver).toBe("sqlite");
  });

  it("creates indexeddb storage when requested", () => {
    const storage = createPriceStorage({ driver: "indexeddb", indexedDb: { dbName: "factory-test" } });
    expect(storage.driver).toBe("indexeddb");
  });
});
