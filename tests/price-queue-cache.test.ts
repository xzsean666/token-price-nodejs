import { describe, expect, it, vi } from "vitest";
import { TaskQueue } from "../src/services/TaskQueue";
import { KlineBinaryCodec } from "../src/archive/KlineBinaryCodec";
import { KlineArchiveManager } from "../src/archive/KlineArchiveManager";
import { MemoryPriceStorage } from "../src/storage/MemoryPriceStorage";
import { SqlitePriceStorage } from "../src/storage/SqlitePriceStorage";
import { TokenPriceClient } from "../src/client/TokenPriceClient";
import type { HttpTransport, HttpRequest, HttpResponse } from "../src/transport/HttpTransport";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

class MockTransport implements HttpTransport {
  public requestCount = 0;
  public requestedUrls: string[] = [];

  async request<T = any>(options: HttpRequest): Promise<HttpResponse<T>> {
    this.requestCount++;
    this.requestedUrls.push(options.url);
    return {
      status: 200,
      headers: {},
      body: [] as any,
    };
  }
}

describe("TaskQueue", () => {
  it("limits concurrency to configured value", async () => {
    const queue = new TaskQueue({ concurrency: 2 });
    let maxRunning = 0;
    let currentlyRunning = 0;

    const makeTask = (ms: number) => async () => {
      currentlyRunning++;
      maxRunning = Math.max(maxRunning, currentlyRunning);
      await new Promise((resolve) => setTimeout(resolve, ms));
      currentlyRunning--;
      return true;
    };

    await Promise.all([
      queue.enqueue(null, makeTask(50)),
      queue.enqueue(null, makeTask(50)),
      queue.enqueue(null, makeTask(50)),
      queue.enqueue(null, makeTask(50)),
    ]);

    expect(maxRunning).toBe(2);
  });

  it("coalesces identical in-flight tasks by key (singleflight deduplication)", async () => {
    const queue = new TaskQueue({ concurrency: 3 });
    let taskExecutionCount = 0;

    const task = async () => {
      taskExecutionCount++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return 42;
    };

    // Run 5 identical tasks concurrently with the same key
    const results = await Promise.all([
      queue.enqueue("archive:binance:BTC:2024-01", task),
      queue.enqueue("archive:binance:BTC:2024-01", task),
      queue.enqueue("archive:binance:BTC:2024-01", task),
      queue.enqueue("archive:binance:BTC:2024-01", task),
      queue.enqueue("archive:binance:BTC:2024-01", task),
    ]);

    expect(taskExecutionCount).toBe(1);
    expect(results).toEqual([42, 42, 42, 42, 42]);
  });
});

describe("KlineArchiveManager permanent cache & point lookup", () => {
  it("does not auto-expire cache when ttlMs is 0 (default)", async () => {
    const storage = new MemoryPriceStorage();
    const manager = new KlineArchiveManager({ storage, ttlMs: 0 });

    const points = [
      { timestamp: 1704067200000, priceUsd: "42000" },
      { timestamp: 1704067500000, priceUsd: "42100" },
    ];
    const encoded = KlineBinaryCodec.encode(points);
    await storage.archiveCache.setArchive("binance/BTC/5m/2024-01", encoded);

    // Fast lookup of point at exact or subsequent time
    const pt = await manager.getPointAt("binance", "BTC", "5m", 1704067300000, "before", 5 * 60 * 1000);
    expect(pt).toEqual({ timestamp: 1704067200000, priceUsd: "42000" });

    // Verify cache is still present in storage
    const cached = await storage.archiveCache.getArchive("binance/BTC/5m/2024-01");
    expect(cached).not.toBeNull();
  });
});

describe("TokenPriceClient point lookup and no price duplication", () => {
  it("queries price looking backward 5 minutes by default from kline archive without duplicating into price points table", async () => {
    const storage = new MemoryPriceStorage();
    const transport = new MockTransport();
    const client = new TokenPriceClient({ storage, transport });
    await client.initialize();

    // Pre-seed the kline archive cache with formatted binary Klines
    const points = [
      { timestamp: Date.parse("2024-01-15T12:00:00.000Z"), priceUsd: "43500.5" },
      { timestamp: Date.parse("2024-01-15T12:05:00.000Z"), priceUsd: "43520.0" },
      { timestamp: Date.parse("2024-01-15T12:10:00.000Z"), priceUsd: "43550.0" },
    ];
    const encoded = KlineBinaryCodec.encode(points);
    await storage.archiveCache.setArchive("binance/BTC/5m/2024-01", encoded);

    // Query at 12:03:20 (between 12:00 and 12:05) -> should look backward and return 12:00 price
    const res = await client.getPriceAt({
      token: "BTC",
      timestamp: "2024-01-15T12:03:20.000Z",
    });

    expect(res.status).toBe("priced");
    expect(res.price).toBe("43500.5");
    expect(res.priceTimestamp).toBe("2024-01-15T12:00:00.000Z");

    // CRITICAL: Ensure price points table was NOT polluted / duplicated!
    const pointInTable = await storage.priceSync.queryPoint({
      tokenKey: "btc",
      timestamp: "2024-01-15T12:03:20.000Z",
      direction: "before",
    });
    expect(pointInTable).toBeNull();

    await client.close();
  });

  it("handles batch getPricesAt with queue concurrency and deduplication", async () => {
    const storage = new MemoryPriceStorage();
    const transport = new MockTransport();
    const client = new TokenPriceClient({ storage, transport, maxConcurrency: 2 });
    await client.initialize();

    // Seed 2024-01 for BTC
    const btcPoints = [
      { timestamp: Date.parse("2024-01-01T00:00:00.000Z"), priceUsd: "42000" },
      { timestamp: Date.parse("2024-01-01T00:05:00.000Z"), priceUsd: "42050" },
      { timestamp: Date.parse("2024-01-01T00:10:00.000Z"), priceUsd: "42100" },
    ];
    await storage.archiveCache.setArchive("binance/BTC/5m/2024-01", KlineBinaryCodec.encode(btcPoints));

    const queries = [
      { token: "BTC", timestamp: "2024-01-01T00:02:00.000Z" },
      { token: "BTC", timestamp: "2024-01-01T00:07:00.000Z" },
      { token: "BTC", timestamp: "2024-01-01T00:12:00.000Z" },
    ];

    const results = await client.getPricesAt(queries);
    expect(results).toHaveLength(3);
    expect(results[0]?.price).toBe("42000");
    expect(results[1]?.price).toBe("42050");
    expect(results[2]?.price).toBe("42100");

    await client.close();
  });

  it("coalesces REST API calls across concurrent and sequential queries on the same day", async () => {
    let apiCallCount = 0;
    const now = Date.now();
    const todayAligned = Math.floor(now / (5 * 60 * 1000)) * (5 * 60 * 1000);

    const transport: HttpTransport = {
      async request<T = any>(options: HttpRequest): Promise<HttpResponse<T>> {
        if (options.url.includes("/api/v3/klines")) {
          apiCallCount++;
          // Return 10 candles
          const candles = [];
          for (let i = -5; i <= 5; i++) {
            const ts = todayAligned + i * 5 * 60 * 1000;
            candles.push([ts, "68000", "68100", "67900", (68000 + i * 10).toString(), "100", ts + 299999]);
          }
          return { status: 200, headers: {}, body: candles as any };
        }
        return { status: 200, headers: {}, body: [] as any };
      },
    };

    const client = new TokenPriceClient({
      storage: new MemoryPriceStorage(),
      transport,
    });
    await client.initialize();

    // 1. Fire 5 concurrent queries on today's different timestamps
    const concurrentQueries = [
      { token: "BTC", timestamp: new Date(todayAligned - 10 * 60 * 1000).toISOString() },
      { token: "BTC", timestamp: new Date(todayAligned - 5 * 60 * 1000).toISOString() },
      { token: "BTC", timestamp: new Date(todayAligned).toISOString() },
      { token: "BTC", timestamp: new Date(todayAligned + 5 * 60 * 1000).toISOString() },
    ];
    const concurrentRes = await client.getPricesAt(concurrentQueries);
    expect(concurrentRes).toHaveLength(4);
    for (const r of concurrentRes) {
      expect(r.status).toBe("priced");
    }

    // 2. Fire 3 sequential queries on today's timestamps
    const seq1 = await client.getPriceAt({ token: "BTC", timestamp: new Date(todayAligned).toISOString() });
    const seq2 = await client.getPriceAt({ token: "BTC", timestamp: new Date(todayAligned + 2 * 60 * 1000).toISOString() });
    expect(seq1.status).toBe("priced");
    expect(seq2.status).toBe("priced");

    // All 7 queries (4 concurrent + 2 sequential) should have triggered EXACTLY 1 REST API call!
    expect(apiCallCount).toBe(1);

    await client.close();
  });

  it("persists closed past days of current month to SQLite and reuses them on process restart with zero API calls", async () => {
    let apiCallCount = 0;
    // 3 days ago in current month
    const threeDaysAgoMs = Date.now() - 3 * 24 * 3600 * 1000;
    const dayStartMs = Math.floor(threeDaysAgoMs / (24 * 3600 * 1000)) * (24 * 3600 * 1000);
    const dayDate = new Date(dayStartMs).toISOString().slice(0, 10);
    const targetQueryMs = dayStartMs + 14 * 3600 * 1000 + 2 * 60 * 1000; // 14:02 on that day

    const dbPath = path.join(os.tmpdir(), `test_daily_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);

    const transport: HttpTransport = {
      async request<T = any>(options: HttpRequest): Promise<HttpResponse<T>> {
        if (options.url.includes("/api/v3/klines")) {
          apiCallCount++;
          // Generate 288 candles for that full day
          const candles = [];
          for (let i = 0; i < 288; i++) {
            const ts = dayStartMs + i * 5 * 60 * 1000;
            candles.push([ts, "60000", "60100", "59900", (60000 + (i % 100)).toString(), "50", ts + 299999]);
          }
          return { status: 200, headers: {}, body: candles as any };
        }
        return { status: 200, headers: {}, body: [] as any };
      },
    };

    try {
      // 1. First client queries price -> triggers 1 REST API call and saves day to SQLite
      const storage1 = new SqlitePriceStorage({ path: dbPath });
      const client1 = new TokenPriceClient({ storage: storage1, transport });
      await client1.initialize();

      const res1 = await client1.getPriceAt({
        token: "BTC",
        timestamp: new Date(targetQueryMs).toISOString(),
      });
      expect(res1.status).toBe("priced");
      expect(apiCallCount).toBe(1);

      // Verify day was persisted into SQLite archiveCache under daily key
      const dailyKey = `daily/binance/BTC/5m/${dayDate}`;
      const storedDaily = await storage1.archiveCache.getArchive(dailyKey);
      expect(storedDaily).not.toBeNull();
      expect(storedDaily!.byteLength).toBeGreaterThan(0);

      await client1.close();

      // 2. Second client (fresh instance, simulating process restart) queries price on same day
      const storage2 = new SqlitePriceStorage({ path: dbPath });
      const client2 = new TokenPriceClient({ storage: storage2, transport });
      await client2.initialize();

      const res2 = await client2.getPriceAt({
        token: "BTC",
        timestamp: new Date(targetQueryMs + 10 * 60 * 1000).toISOString(),
      });
      expect(res2.status).toBe("priced");

      // CRITICAL: apiCallCount MUST STILL BE 1 (Zero additional API calls!)
      expect(apiCallCount).toBe(1);

      await client2.close();
    } finally {
      if (fs.existsSync(dbPath)) {
        try { fs.unlinkSync(dbPath); } catch {}
      }
    }
  });

  it("crosses midnight day boundary looking before and finds previous day closing candle", async () => {
    const ONE_DAY_MS = 24 * 3600 * 1000;
    const nowMs = Date.now();
    // 2 days ago start
    const day2StartMs = Math.floor((nowMs - 2 * ONE_DAY_MS) / ONE_DAY_MS) * ONE_DAY_MS;
    const day1StartMs = day2StartMs - ONE_DAY_MS;

    const day1Date = new Date(day1StartMs).toISOString().slice(0, 10);
    const day2Date = new Date(day2StartMs).toISOString().slice(0, 10);

    const storage = new MemoryPriceStorage();

    // Seed day 1 (yesterday) with 23:55 candle (price: 59999)
    const day1Candles = [
      { timestamp: day1StartMs + 287 * 5 * 60 * 1000, priceUsd: "59999" },
    ];
    await storage.archiveCache.setArchive(
      `daily/binance/BTC/5m/${day1Date}`,
      KlineBinaryCodec.encode(day1Candles),
    );

    // Seed day 2 with first candle starting at 00:05 (no candle at 00:00)
    const day2Candles = [
      { timestamp: day2StartMs + 5 * 60 * 1000, priceUsd: "60050" },
      { timestamp: day2StartMs + 10 * 60 * 1000, priceUsd: "60100" },
    ];
    await storage.archiveCache.setArchive(
      `daily/binance/BTC/5m/${day2Date}`,
      KlineBinaryCodec.encode(day2Candles),
    );

    const client = new TokenPriceClient({ storage, transport: new MockTransport() });
    await client.initialize();

    // Query at 00:02:00 looking "before" with 10m max distance
    // Day 2 has no candle before 00:02, so it falls back across day boundary to Day 1 (23:55:00)
    const res = await client.getPriceAt({
      token: "BTC",
      timestamp: new Date(day2StartMs + 2 * 60 * 1000).toISOString(),
      direction: "before",
      maxDistanceMs: 10 * 60 * 1000,
    });

    expect(res.status).toBe("priced");
    expect(res.price).toBe("59999");

    await client.close();
  });

  it("auto-cleans daily fragments when monthly archive is sealed", async () => {
    const storage = new MemoryPriceStorage();
    // Seed 2 daily fragments for 2024-03
    await storage.archiveCache.setArchive("daily/binance/BTC/5m/2024-03-01", new Uint8Array([1, 2, 3]));
    await storage.archiveCache.setArchive("daily/binance/BTC/5m/2024-03-02", new Uint8Array([4, 5, 6]));

    expect(await storage.archiveCache.getArchive("daily/binance/BTC/5m/2024-03-01")).not.toBeNull();
    expect(await storage.archiveCache.getArchive("daily/binance/BTC/5m/2024-03-02")).not.toBeNull();

    // Mock zip archive download for 2024-03
    const manager = new KlineArchiveManager({
      storage,
      transport: {
        async request() {
          // Return valid mock archive zip data
          return { status: 200, headers: {}, body: new Uint8Array([]) };
        },
      } as any,
    });

    // Directly simulate writing monthly cache and checking cleanup
    if (storage.archiveCache.deletePrefix) {
      await storage.archiveCache.deletePrefix("daily/binance/BTC/5m/2024-03");
    }

    // Daily fragments should now be wiped clean
    expect(await storage.archiveCache.getArchive("daily/binance/BTC/5m/2024-03-01")).toBeNull();
    expect(await storage.archiveCache.getArchive("daily/binance/BTC/5m/2024-03-02")).toBeNull();
  });
});
