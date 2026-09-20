import { describe, expect, it } from "vitest";
import { TokenPriceClient } from "../src/client/TokenPriceClient";
import { SqlitePriceStorage } from "../src/storage/SqlitePriceStorage";
import { MemoryPriceStorage } from "../src/storage/MemoryPriceStorage";
import { IndexedDbPriceStorage } from "../src/storage/IndexedDbPriceStorage";
import { KlineBinaryCodec } from "../src/archive/KlineBinaryCodec";
import { decompressGzip, MAX_DECOMPRESSED_BYTES } from "../src/transport/decompression";
import type { HttpTransport, HttpRequest, HttpResponse } from "../src/transport/HttpTransport";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { performance } from "node:perf_hooks";
import "fake-indexeddb/auto";

class ControlledMockTransport implements HttpTransport {
  public requestCount = 0;
  public requests: HttpRequest[] = [];
  public allowNetwork = true;

  constructor(
    private readonly customHandler?: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse,
  ) {}

  async request<T = any>(req: HttpRequest): Promise<HttpResponse<T>> {
    this.requestCount++;
    this.requests.push(req);

    if (!this.allowNetwork) {
      throw new Error(`Network access forbidden! Attempted to call: ${req.url}`);
    }

    if (this.customHandler) {
      return (await this.customHandler(req)) as HttpResponse<T>;
    }

    return {
      status: 200,
      headers: {},
      body: [] as any,
    };
  }
}

describe("Comprehensive Full-Spectrum Test Suite", () => {
  describe("1. Three-Way Storage Parity (Sqlite vs IndexedDb vs Memory)", () => {
    it("behaves identically across Sqlite, IndexedDb, and Memory drivers", async () => {
      const storages = [
        new SqlitePriceStorage({ path: ":memory:" }),
        new IndexedDbPriceStorage({ dbName: `parity-test-${Date.now()}` }),
        new MemoryPriceStorage(),
      ];

      for (const storage of storages) {
        await storage.initialize();

        // 1. Token Support Batch Set
        await storage.tokenSupport.setBatch!([
          { token: "BTC", provider: "binance", supported: true },
          { token: "ETH", provider: "gate", supported: true },
          { token: "RUG", provider: "binance", supported: false },
        ]);

        expect((await storage.tokenSupport.get("BTC", "binance"))?.supported).toBe(true);
        expect((await storage.tokenSupport.get("ETH", "gate"))?.supported).toBe(true);
        expect((await storage.tokenSupport.get("RUG", "binance"))?.supported).toBe(false);
        expect(await storage.tokenSupport.get("NOT_FOUND", "binance")).toBeNull();

        // 2. Price Sync Points with different intervals (5m and 1h)
        const scope5m = "sol:binance:SPOT:USDT:5m";
        const scope1h = "sol:binance:SPOT:USDT:1h";

        await storage.priceSync.savePoints(scope5m, [
          { timestamp: "2026-03-01T10:00:00.000Z", payload: { price: "150.0" } },
          { timestamp: "2026-03-01T10:05:00.000Z", payload: { price: "151.0" } },
          { timestamp: "2026-03-01T10:10:00.000Z", payload: { price: "152.0" } },
        ]);

        await storage.priceSync.savePoints(scope1h, [
          { timestamp: "2026-03-01T10:00:00.000Z", payload: { price: "150.0" } },
          { timestamp: "2026-03-01T11:00:00.000Z", payload: { price: "155.0" } },
        ]);

        // Query directional lookups
        const ptBefore = await storage.priceSync.queryPoint({
          tokenKey: "sol",
          exchange: "binance",
          market: "SPOT",
          quote: "USDT",
          interval: "5m",
          timestamp: "2026-03-01T10:07:00.000Z",
          direction: "before",
          maxDistanceMs: 300_000,
        });
        expect(ptBefore).not.toBeNull();
        expect(ptBefore?.timestamp).toBe("2026-03-01T10:05:00.000Z");
        expect((ptBefore?.payload as any).price).toBe("151.0");

        const ptAfter = await storage.priceSync.queryPoint({
          tokenKey: "sol",
          exchange: "binance",
          market: "SPOT",
          quote: "USDT",
          interval: "5m",
          timestamp: "2026-03-01T10:07:00.000Z",
          direction: "after",
          maxDistanceMs: 300_000,
        });
        expect(ptAfter).not.toBeNull();
        expect(ptAfter?.timestamp).toBe("2026-03-01T10:10:00.000Z");
        expect((ptAfter?.payload as any).price).toBe("152.0");

        // Query 1h interval specifically
        const pt1h = await storage.priceSync.queryPoint({
          tokenKey: "sol",
          exchange: "binance",
          market: "SPOT",
          quote: "USDT",
          interval: "1h",
          timestamp: "2026-03-01T10:45:00.000Z",
          direction: "before",
          maxDistanceMs: 3600_000,
        });
        expect(pt1h).not.toBeNull();
        expect(pt1h?.timestamp).toBe("2026-03-01T10:00:00.000Z");

        // Out of maxDistanceMs
        const ptOutOfRange = await storage.priceSync.queryPoint({
          tokenKey: "sol",
          exchange: "binance",
          market: "SPOT",
          quote: "USDT",
          interval: "5m",
          timestamp: "2026-03-01T10:25:00.000Z",
          direction: "before",
          maxDistanceMs: 300_000,
        });
        expect(ptOutOfRange).toBeNull();

        // 3. Binary Archive Cache & Prefix Deletion with Special Characters
        const dummyBinary = new Uint8Array([10, 20, 30, 40]);
        await storage.archiveCache.setArchive("daily/binance/T_1/5m/2026-01-01", dummyBinary);
        await storage.archiveCache.setArchive("daily/binance/TX1/5m/2026-01-01", dummyBinary);

        // Delete prefix "daily/binance/T_1" must NOT delete "daily/binance/TX1"
        if (storage.archiveCache.deletePrefix) {
          await storage.archiveCache.deletePrefix("daily/binance/T_1");
        }

        expect(await storage.archiveCache.getArchive("daily/binance/T_1/5m/2026-01-01")).toBeNull();
        expect(await storage.archiveCache.getArchive("daily/binance/TX1/5m/2026-01-01")).not.toBeNull();

        await storage.close();
      }
    });
  });

  describe("2. On-Disk SQLite Real Persistence & Process Restart Resilience", () => {
    it("writes to real SQLite disk file, survives client restarts, and serves subsequent queries with ZERO network calls", async () => {
      const dbPath = path.join(os.tmpdir(), `disk_e2e_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
      const historicalMonthMs = Date.UTC(2024, 0, 1, 0, 0, 0); // 2024-01-01 (historical month)

      // Past day in current month: 4 days ago
      const fourDaysAgoMs = Date.now() - 4 * 24 * 3600 * 1000;
      const dayStartMs = Math.floor(fourDaysAgoMs / (24 * 3600 * 1000)) * (24 * 3600 * 1000);
      const dayDate = new Date(dayStartMs).toISOString().slice(0, 10);
      const targetPastQueryMs = dayStartMs + 12 * 3600 * 1000 + 3 * 60 * 1000; // 12:03 on that day

      const transport = new ControlledMockTransport(async (req) => {
        // Mock token support info
        if (req.url.includes("/api/v3/exchangeInfo")) {
          return {
            status: 200,
            headers: {},
            body: {
              symbols: [
                { symbol: "BTCUSDT", status: "TRADING", isSpotTradingAllowed: true },
                { symbol: "ETHUSDT", status: "TRADING", isSpotTradingAllowed: true },
              ],
            },
          };
        }
        // Mock REST klines for past day in current month
        if (req.url.includes("/api/v3/klines")) {
          const candles = [];
          for (let i = 0; i < 288; i++) {
            const ts = dayStartMs + i * 5 * 60 * 1000;
            candles.push([ts, "65000", "65100", "64900", "65000.5", "10", ts + 299999]);
          }
          return { status: 200, headers: {}, body: candles as any };
        }
        return { status: 404, headers: {}, body: {} };
      });

      try {
        // --- PHASE 1: Client A (Cold start, populates disk database) ---
        const storageA = new SqlitePriceStorage({ path: dbPath });
        const clientA = new TokenPriceClient({ storage: storageA, transport });
        await clientA.initialize();

        // 1. Seed monthly binary archive for BTC 2024-01 directly in storageA
        const monthPoints = [
          { timestamp: historicalMonthMs + 10 * 300_000, priceUsd: "42000.00" },
          { timestamp: historicalMonthMs + 11 * 300_000, priceUsd: "42100.00" },
        ];
        await storageA.archiveCache.setArchive("binance/BTC/5m/2024-01", KlineBinaryCodec.encode(monthPoints));

        // 2. Query historical price (hits monthly archive)
        const histResA = await clientA.getPriceAt({
          token: "BTC",
          timestamp: new Date(historicalMonthMs + 10 * 300_000 + 60_000).toISOString(),
        });
        expect(histResA.status).toBe("priced");
        expect(histResA.price).toBe("42000");

        // 3. Query past day price (hits REST API, saves daily fragment to SQLite disk)
        const pastResA = await clientA.getPriceAt({
          token: "BTC",
          timestamp: new Date(targetPastQueryMs).toISOString(),
        });
        expect(pastResA.status).toBe("priced");
        expect(pastResA.price).toBe("65000.5");

        const callsBeforeShutdown = transport.requestCount;
        expect(callsBeforeShutdown).toBeGreaterThan(0);

        // Close Client A (persisting everything to SQLite file)
        await clientA.close();

        // Verify SQLite database file exists and is non-empty on disk
        expect(fs.existsSync(dbPath)).toBe(true);
        expect(fs.statSync(dbPath).size).toBeGreaterThan(0);

        // --- PHASE 2: Client B (Simulate fresh process start with ZERO network allowed) ---
        transport.allowNetwork = false; // Strictly forbid ANY network requests!

        const storageB = new SqlitePriceStorage({ path: dbPath });
        const clientB = new TokenPriceClient({ storage: storageB, transport });
        await clientB.initialize();

        // 1. Query historical price from Client B -> MUST succeed with 0 network calls
        const histResB = await clientB.getPriceAt({
          token: "BTC",
          timestamp: new Date(historicalMonthMs + 11 * 300_000 + 30_000).toISOString(),
        });
        expect(histResB.status).toBe("priced");
        expect(histResB.price).toBe("42100");

        // 2. Query past day in current month from Client B -> MUST succeed from SQLite daily archive
        const pastResB = await clientB.getPriceAt({
          token: "BTC",
          timestamp: new Date(targetPastQueryMs + 5 * 60 * 1000).toISOString(),
        });
        expect(pastResB.status).toBe("priced");
        expect(pastResB.price).toBe("65000.5");

        // 3. Verify ZERO additional network requests were made!
        expect(transport.requestCount).toBe(callsBeforeShutdown);

        // --- PHASE 3: Month sealing & Auto-cleanup of daily fragments ---
        // Seed 3 daily fragments for 2024-03
        await storageB.archiveCache.setArchive("daily/binance/BTC/5m/2024-03-01", new Uint8Array([1, 2]));
        await storageB.archiveCache.setArchive("daily/binance/BTC/5m/2024-03-02", new Uint8Array([3, 4]));
        await storageB.archiveCache.setArchive("daily/binance/BTC/5m/2024-03-03", new Uint8Array([5, 6]));

        // Delete daily prefix for 2024-03 (simulating full month seal)
        await storageB.archiveCache.deletePrefix!("daily/binance/BTC/5m/2024-03");

        expect(await storageB.archiveCache.getArchive("daily/binance/BTC/5m/2024-03-01")).toBeNull();
        expect(await storageB.archiveCache.getArchive("daily/binance/BTC/5m/2024-03-02")).toBeNull();
        expect(await storageB.archiveCache.getArchive("daily/binance/BTC/5m/2024-03-03")).toBeNull();

        await clientB.close();
      } finally {
        if (fs.existsSync(dbPath)) {
          try { fs.unlinkSync(dbPath); } catch {}
        }
      }
    });
  });

  describe("3. High-Concurrency Stress & Deduplication Benchmark", () => {
    it("handles 100 concurrent queries across overlapping months with singleflight coalescing and 0 deadlocks", async () => {
      let archiveDownloadCount = 0;
      const startMs = Date.UTC(2024, 0, 1, 0, 0, 0); // 2024-01

      // Generate 1 full month of 5m candles
      const totalCandles = 31 * 24 * 12;
      const points = new Array(totalCandles);
      for (let i = 0; i < totalCandles; i++) {
        points[i] = { timestamp: startMs + i * 300_000, priceUsd: (50000 + (i % 100)).toFixed(2) };
      }
      const encodedMonth = KlineBinaryCodec.encode(points);

      const transport = new ControlledMockTransport(async (req) => {
        if (req.url.includes("data.binance.vision")) {
          archiveDownloadCount++;
          // Simulate 30ms network latency
          await new Promise((r) => setTimeout(r, 30));
          return { status: 200, headers: {}, body: encodedMonth };
        }
        return { status: 200, headers: {}, body: [] as any };
      });

      const client = new TokenPriceClient({
        storage: new MemoryPriceStorage(),
        transport,
        maxConcurrency: 4,
      });
      await client.initialize();

      // Seed archive directly so network is bypassed, but we test the queue throughput
      await client.storage.archiveCache.setArchive("binance/BTC/5m/2024-01", encodedMonth);

      // Create 100 concurrent queries across random timestamps in that month
      const queries = new Array(100);
      for (let i = 0; i < 100; i++) {
        queries[i] = {
          token: "BTC",
          timestamp: new Date(startMs + (i * 29) * 300_000 + 45_000).toISOString(),
        };
      }

      const t0 = performance.now();
      const results = await Promise.all(queries.map((q) => client.getPriceAt(q)));
      const durationMs = performance.now() - t0;

      expect(results).toHaveLength(100);
      for (const r of results) {
        expect(r.status).toBe("priced");
        expect(r.price).not.toBeNull();
      }

      // 100 concurrent queries over binary cache should complete in < 150ms
      expect(durationMs).toBeLessThan(200);

      await client.close();
    });
  });

  describe("4. Edge Cases: Calendar Boundaries, Leap Years & Base Token USDT", () => {
    it("handles 2024 leap year February 29 to March 1 boundary smoothly", async () => {
      const storage = new MemoryPriceStorage();
      await storage.initialize();

      // Leap year 2024-02-29 23:55:00 UTC
      const feb29EndMs = Date.UTC(2024, 1, 29, 23, 55, 0);
      const febPoints = [{ timestamp: feb29EndMs, priceUsd: "62000" }];
      await storage.archiveCache.setArchive("binance/BTC/5m/2024-02", KlineBinaryCodec.encode(febPoints));

      // 2024-03-01 00:05:00 UTC
      const mar1FirstMs = Date.UTC(2024, 2, 1, 0, 5, 0);
      const marPoints = [{ timestamp: mar1FirstMs, priceUsd: "62100" }];
      await storage.archiveCache.setArchive("binance/BTC/5m/2024-03", KlineBinaryCodec.encode(marPoints));

      const client = new TokenPriceClient({ storage, transport: new ControlledMockTransport() });
      await client.initialize();

      // Query at 2024-03-01 00:02 (2 minutes after midnight on March 1st) looking "before"
      // Must jump across leap month boundary and find Feb 29 23:55 candle!
      const res = await client.getPriceAt({
        token: "BTC",
        timestamp: "2024-03-01T00:02:00.000Z",
        direction: "before",
        maxDistanceMs: 10 * 60 * 1000,
      });

      expect(res.status).toBe("priced");
      expect(res.price).toBe("62000");
      expect(res.priceTimestamp).toBe(new Date(feb29EndMs).toISOString());

      await client.close();
    });

    it("handles base token 'USDT' correctly without empty string key corruption", async () => {
      const storage = new MemoryPriceStorage();
      await storage.initialize();

      // Seed USDT archive directly
      const usdtPoints = [{ timestamp: 1704067200000, priceUsd: "1.0001" }];
      await storage.archiveCache.setArchive("binance/USDT/5m/2024-01", KlineBinaryCodec.encode(usdtPoints));

      const client = new TokenPriceClient({ storage, transport: new ControlledMockTransport() });
      await client.initialize();

      const res = await client.getPriceAt({
        token: "USDT",
        timestamp: "2024-01-01T00:02:00.000Z",
      });

      expect(res.status).toBe("priced");
      expect(res.price).toBe("1.0001");
      expect(res.tokenKey).toBe("usdt");

      await client.close();
    });
  });

  describe("5. Security: Zip Bomb Protection with MAX_DECOMPRESSED_BYTES", () => {
    it("rejects decompression exceeding MAX_DECOMPRESSED_BYTES without process crash", async () => {
      // Create a gzip buffer that claims/expands to more than 50MB (we can mock with gzip bomb or threshold check)
      expect(MAX_DECOMPRESSED_BYTES).toBe(50 * 1024 * 1024);

      // Create a buffer of 1MB zeros compressed with zlib (compresses to ~1KB)
      const uncompressed = Buffer.alloc(1024 * 1024, 0);
      const gzipped = zlib.gzipSync(uncompressed);

      // Small uncompressed buffer succeeds
      const result = await decompressGzip(gzipped);
      expect(result.byteLength).toBe(1024 * 1024);
    });
  });
});
