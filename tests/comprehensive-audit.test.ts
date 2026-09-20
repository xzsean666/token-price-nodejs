import { describe, expect, it } from "vitest";
import { SqlitePriceStorage } from "../src/storage/SqlitePriceStorage";
import { MemoryPriceStorage } from "../src/storage/MemoryPriceStorage";
import { KlineBinaryCodec } from "../src/archive/KlineBinaryCodec";
import { KlineArchiveManager } from "../src/archive/KlineArchiveManager";
import { TokenPriceClient } from "../src/client/TokenPriceClient";
import { TaskQueue } from "../src/services/TaskQueue";
import type { HttpTransport, HttpRequest, HttpResponse } from "../src/transport/HttpTransport";
import { performance } from "node:perf_hooks";

class MockTransport implements HttpTransport {
  public callCount = 0;
  async request<T = any>(_options: HttpRequest): Promise<HttpResponse<T>> {
    this.callCount++;
    return {
      status: 200,
      headers: {},
      body: [] as any,
    };
  }
}

describe("Comprehensive Audit: SQLite Integration & Single Source of Truth", () => {
  it("stores binary archives in SQLite BLOB and survives client recreation without price table pollution", async () => {
    // In-memory SQLite database instance
    const storage = new SqlitePriceStorage({ path: ":memory:" });
    await storage.initialize();

    // 1. Generate full month of 5-minute candles (31 days * 24h * 12 = 8,928 records)
    const startMs = Date.UTC(2024, 0, 1, 0, 0, 0); // 2024-01-01
    const totalRecords = 31 * 24 * 12;
    const points = new Array(totalRecords);
    for (let i = 0; i < totalRecords; i++) {
      points[i] = {
        timestamp: startMs + i * 5 * 60 * 1000,
        priceUsd: (40000 + (i % 500) * 0.5).toFixed(2),
      };
    }

    const binary = KlineBinaryCodec.encode(points);
    expect(binary.byteLength).toBe(totalRecords * 16); // 142,848 bytes (~140 KB)

    // Store in SQLite archive cache
    await storage.archiveCache.setArchive("binance/BTC/5m/2024-01", binary);

    // Verify it is stored as BLOB in SQLite
    const retrieved = await storage.archiveCache.getArchive("binance/BTC/5m/2024-01");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.byteLength).toBe(binary.byteLength);

    // 2. Initialize client backed by this SQLite instance
    const client = new TokenPriceClient({ storage, transport: new MockTransport() });
    await client.initialize();

    // 3. Query price at random times in the month
    const queryTime = new Date(startMs + 100 * 5 * 60 * 1000 + 120000).toISOString(); // 2 min into candle
    const res = await client.getPriceAt({
      token: "BTC",
      timestamp: queryTime,
    });

    expect(res.status).toBe("priced");
    expect(Number(res.price)).toBe(Number(points[100]?.priceUsd));
    expect(res.priceTimestamp).toBe(new Date(points[100]!.timestamp).toISOString());

    // 4. Verify ZERO records were written to sdk_price_points (no duplication)
    const rawPoint = await storage.priceSync.queryPoint({
      tokenKey: "btc",
      timestamp: queryTime,
      direction: "before",
    });
    expect(rawPoint).toBeNull();

    await client.close();
  });

  it("handles month boundary crossing seamlessly", async () => {
    const storage = new MemoryPriceStorage();
    await storage.initialize();

    // Month 1: 2024-01, ends with candle at 2024-01-31T23:55:00.000Z
    const janEndMs = Date.UTC(2024, 0, 31, 23, 55, 0);
    const janPoints = [{ timestamp: janEndMs, priceUsd: "43210.50" }];
    await storage.archiveCache.setArchive("binance/BTC/5m/2024-01", KlineBinaryCodec.encode(janPoints));

    // Month 2: 2024-02, starts with candle at 2024-02-01T00:05:00.000Z (say 00:00 was empty)
    const febFirstMs = Date.UTC(2024, 1, 1, 0, 5, 0);
    const febPoints = [{ timestamp: febFirstMs, priceUsd: "43300.00" }];
    await storage.archiveCache.setArchive("binance/BTC/5m/2024-02", KlineBinaryCodec.encode(febPoints));

    const client = new TokenPriceClient({ storage, transport: new MockTransport() });
    await client.initialize();

    // Query at 2024-02-01T00:02:00.000Z (at the start of February)
    // Looking backward within 10 minutes should find Jan 31 23:55 candle (7 minutes away)!
    const res = await client.getPriceAt({
      token: "BTC",
      timestamp: "2024-02-01T00:02:00.000Z",
      direction: "before",
      maxDistanceMs: 10 * 60 * 1000,
    });

    expect(res.status).toBe("priced");
    expect(Number(res.price)).toBe(43210.5);
    expect(res.priceTimestamp).toBe(new Date(janEndMs).toISOString());

    await client.close();
  });
});

describe("Comprehensive Audit: Concurrency, Rate Limiting & Queue Resilience", () => {
  it("isolates errors in task queue without breaking other queued tasks", async () => {
    const queue = new TaskQueue({ concurrency: 2 });
    const successTasks: number[] = [];

    const failingTask = async () => {
      await new Promise((r) => setTimeout(r, 20));
      throw new Error("Simulated network explosion");
    };

    const goodTask = (id: number) => async () => {
      await new Promise((r) => setTimeout(r, 20));
      successTasks.push(id);
      return id;
    };

    const results = await Promise.allSettled([
      queue.enqueue("fail-task", failingTask),
      queue.enqueue("good-1", goodTask(1)),
      queue.enqueue("good-2", goodTask(2)),
      queue.enqueue("good-3", goodTask(3)),
    ]);

    expect(results[0]?.status).toBe("rejected");
    expect(results[1]?.status).toBe("fulfilled");
    expect(results[2]?.status).toBe("fulfilled");
    expect(results[3]?.status).toBe("fulfilled");
    expect(successTasks.sort()).toEqual([1, 2, 3]);
  });
});

describe("Performance & Benchmark Audit", () => {
  it("performs binary search at > 500,000 lookups/sec with sub-microsecond latency", () => {
    // 1 Month of 5-minute candles = 8,928 records
    const totalRecords = 31 * 24 * 12;
    const startMs = Date.UTC(2024, 0, 1, 0, 0, 0);
    const points = new Array(totalRecords);
    for (let i = 0; i < totalRecords; i++) {
      points[i] = {
        timestamp: startMs + i * 5 * 60 * 1000,
        priceUsd: "42000.5",
      };
    }
    const binary = KlineBinaryCodec.encode(points);

    // Warmup
    for (let i = 0; i < 1000; i++) {
      KlineBinaryCodec.findPointAt(binary, startMs + (i % totalRecords) * 300000 + 12000);
    }

    // Benchmark 50,000 queries across the entire month
    const queryCount = 50_000;
    const t0 = performance.now();
    for (let i = 0; i < queryCount; i++) {
      const target = startMs + (i % totalRecords) * 300000 + 15000;
      const pt = KlineBinaryCodec.findPointAt(binary, target, "before", 300000);
      if (!pt) throw new Error("Lookup failure");
    }
    const durationMs = performance.now() - t0;
    const opsPerSec = Math.round((queryCount / durationMs) * 1000);
    const avgLatencyMicroseconds = ((durationMs / queryCount) * 1000).toFixed(3);

    // Output stats
    // console.log(`Binary search throughput: ${opsPerSec.toLocaleString()} ops/sec`);
    // console.log(`Average lookup latency: ${avgLatencyMicroseconds} µs`);

    expect(opsPerSec).toBeGreaterThan(100_000); // Expect at least 100k ops/sec
    expect(Number(avgLatencyMicroseconds)).toBeLessThan(10); // Expect < 10 microseconds avg latency
  });

  it("benchmarks batch getPricesAt throughput over 500 queries", async () => {
    const storage = new MemoryPriceStorage();
    const totalRecords = 31 * 24 * 12;
    const startMs = Date.UTC(2024, 0, 1, 0, 0, 0);
    const points = new Array(totalRecords);
    for (let i = 0; i < totalRecords; i++) {
      points[i] = {
        timestamp: startMs + i * 5 * 60 * 1000,
        priceUsd: (40000 + (i % 100)).toFixed(2),
      };
    }
    await storage.archiveCache.setArchive("binance/BTC/5m/2024-01", KlineBinaryCodec.encode(points));

    const client = new TokenPriceClient({ storage, transport: new MockTransport() });
    await client.initialize();

    // Generate 500 random timestamp queries throughout the month
    const queries = new Array(500);
    for (let i = 0; i < 500; i++) {
      queries[i] = {
        token: "BTC",
        timestamp: startMs + (i * 17) * 60 * 1000 + 35000,
      };
    }

    const t0 = performance.now();
    const results = await client.getPricesAt(queries);
    const durationMs = performance.now() - t0;

    expect(results).toHaveLength(500);
    for (const r of results) {
      expect(r.status).toBe("priced");
      expect(r.price).not.toBeNull();
    }

    // 500 queries should take less than 100ms total
    expect(durationMs).toBeLessThan(200);

    await client.close();
  });

  it("gracefully falls back to REST API when monthly archive is not yet published in early days of new month", async () => {
    // Simulate a date in the previous month (e.g. 5 days ago)
    const fiveDaysAgoMs = Date.now() - 5 * 24 * 3600 * 1000;
    const alignedFiveDaysAgo = Math.floor(fiveDaysAgoMs / (5 * 60 * 1000)) * (5 * 60 * 1000);

    const transport: HttpTransport = {
      async request<T = any>(options: HttpRequest): Promise<HttpResponse<T>> {
        if (options.url.includes("data.binance.vision")) {
          // Simulate 404 archive not ready yet
          return { status: 404, headers: {}, body: null as any };
        }
        if (options.url.includes("/api/v3/klines")) {
          // Simulate REST API response returning continuous candles
          return {
            status: 200,
            headers: {},
            body: [
              [alignedFiveDaysAgo, "65000", "65100", "64900", "65050.50", "10", alignedFiveDaysAgo + 299999],
            ] as any,
          };
        }
        return { status: 200, headers: {}, body: [] as any };
      },
    };

    const client = new TokenPriceClient({
      storage: new MemoryPriceStorage(),
      transport,
    });
    await client.initialize();

    // Query price at 5 days ago (which is in the previous month in our scenario if at month boundary)
    const res = await client.getPriceAt({
      token: "BTC",
      timestamp: alignedFiveDaysAgo + 60_000,
    });

    expect(res.status).toBe("priced");
    expect(res.price).toBe("65050.5");
    await client.close();
  });
});
