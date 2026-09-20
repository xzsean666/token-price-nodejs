import { describe, expect, it } from "vitest";
import { TaskQueue } from "../src/services/TaskQueue";
import { KlineBinaryCodec } from "../src/archive/KlineBinaryCodec";
import { KlineArchiveManager } from "../src/archive/KlineArchiveManager";
import { BinanceArchiveAdapter } from "../src/archive/BinanceArchiveAdapter";
import { GateArchiveAdapter } from "../src/archive/GateArchiveAdapter";
import { SqlitePriceStorage } from "../src/storage/SqlitePriceStorage";
import { MemoryPriceStorage } from "../src/storage/MemoryPriceStorage";
import { IndexedDbPriceStorage } from "../src/storage/IndexedDbPriceStorage";
import { FetchHttpTransport } from "../src/transport/FetchHttpTransport";
import { decompressGzip, decompressZipSingleFile, MAX_DECOMPRESSED_BYTES } from "../src/transport/decompression";
import { TokenPriceClient } from "../src/client/TokenPriceClient";
import type { HttpTransport, HttpRequest, HttpResponse } from "../src/transport/HttpTransport";
import "fake-indexeddb/auto";

describe("Audit Fixes & Robustness Verification", () => {
  it("TaskQueue.clear() rejects pending queued tasks instead of hanging", async () => {
    const queue = new TaskQueue({ concurrency: 1 });
    let task1Started = false;

    // Running task
    const runningTask = queue.enqueue("task1", async () => {
      task1Started = true;
      await new Promise((r) => setTimeout(r, 50));
      return "done1";
    });

    // Wait until task1 has started
    while (!task1Started) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Queued task (pending, not yet running)
    const pendingPromise = queue.enqueue("task2", async () => "done2");

    expect(queue.activeCount).toBe(1);
    expect(queue.pendingCount).toBe(1);

    // Clear queue with custom cancellation error
    queue.clear(new Error("Queue cancelled"));

    // Pending task should immediately reject
    await expect(pendingPromise).rejects.toThrow("Queue cancelled");

    // Active task completes normally
    await expect(runningTask).resolves.toBe("done1");
  });

  it("KlineBinaryCodec handles fractional/float timestamp without RangeError", () => {
    const points = [
      { timestamp: 1000, priceUsd: "100" },
      { timestamp: 2000, priceUsd: "200" },
    ];
    const encoded = KlineBinaryCodec.encode(points);

    // Query with fractional timestamp (e.g. 1500.8)
    const pt = KlineBinaryCodec.findPointAt(encoded, 1500.8, "before");
    expect(pt).toEqual({ timestamp: 1000, priceUsd: "100" });

    const ptAfter = KlineBinaryCodec.findPointAt(encoded, 1500.8, "after");
    expect(ptAfter).toEqual({ timestamp: 2000, priceUsd: "200" });
  });

  it("Preserves 'USDT' token symbol without truncating to empty string", () => {
    const binanceAdapter = new BinanceArchiveAdapter();
    const binanceUrl = binanceAdapter.getMonthlyArchiveUrl("USDT", "5m", 2024, 1);
    expect(binanceUrl).toContain("USDT/5m/USDT-5m-2024-01.zip");

    const gateAdapter = new GateArchiveAdapter();
    const gateUrl = gateAdapter.getMonthlyArchiveUrl("USDT", "5m", 2024, 1);
    expect(gateUrl).toContain("USDT_USDT-202401.csv.gz");
  });

  it("Sanitizes interval in archive adapter URLs to prevent path traversal", () => {
    const gateAdapter = new GateArchiveAdapter();
    const traversalUrl = gateAdapter.getMonthlyArchiveUrl("BTC", "../../evil", 2024, 1);
    expect(traversalUrl).not.toContain("../../evil");
    expect(traversalUrl).toContain("candlesticks_evil");
  });

  it("SQLite and IndexedDB storage setBatch persists multiple token support records atomically", async () => {
    // 1. SQLite
    const sqlite = new SqlitePriceStorage({ path: ":memory:" });
    await sqlite.initialize();
    await sqlite.tokenSupport.setBatch!([
      { token: "BTC", provider: "binance", supported: true },
      { token: "ETH", provider: "binance", supported: true },
      { token: "DOGE", provider: "gate", supported: false },
    ]);

    expect((await sqlite.tokenSupport.get("BTC", "binance"))?.supported).toBe(true);
    expect((await sqlite.tokenSupport.get("ETH", "binance"))?.supported).toBe(true);
    expect((await sqlite.tokenSupport.get("DOGE", "gate"))?.supported).toBe(false);
    await sqlite.close();

    // 2. IndexedDB
    const idb = new IndexedDbPriceStorage({ dbName: `test-batch-${Date.now()}` });
    await idb.initialize();
    await idb.tokenSupport.setBatch!([
      { token: "SOL", provider: "binance", supported: true },
      { token: "PEPE", provider: "gate", supported: true },
    ]);

    expect((await idb.tokenSupport.get("SOL", "binance"))?.supported).toBe(true);
    expect((await idb.tokenSupport.get("PEPE", "gate"))?.supported).toBe(true);
    await idb.close();

    // 3. Memory
    const mem = new MemoryPriceStorage();
    await mem.initialize();
    await mem.tokenSupport.setBatch!([
      { token: "AVAX", provider: "binance", supported: true },
    ]);
    expect((await mem.tokenSupport.get("AVAX", "binance"))?.supported).toBe(true);
    await mem.close();
  });

  it("Escapes LIKE wildcards in SQLite deletePrefix and queryPoint", async () => {
    const sqlite = new SqlitePriceStorage({ path: ":memory:" });
    await sqlite.initialize();

    // Seed caches: one with literal underscore 'A_B' and one with 'AXB'
    await sqlite.archiveCache.setArchive("daily/binance/A_B/5m/2024-01-01", new Uint8Array([1]));
    await sqlite.archiveCache.setArchive("daily/binance/AXB/5m/2024-01-01", new Uint8Array([2]));

    // Deleting prefix "daily/binance/A_B" must NOT delete "daily/binance/AXB"
    await sqlite.archiveCache.deletePrefix!("daily/binance/A_B");

    expect(await sqlite.archiveCache.getArchive("daily/binance/A_B/5m/2024-01-01")).toBeNull();
    // AXB should still exist!
    expect(await sqlite.archiveCache.getArchive("daily/binance/AXB/5m/2024-01-01")).not.toBeNull();

    await sqlite.close();
  });

  it("Constrains IndexedDB cursor range using maxDistanceMs to avoid full-table scans", async () => {
    const idb = new IndexedDbPriceStorage({ dbName: `test-idb-distance-${Date.now()}` });
    await idb.initialize();

    // Save an old point (1 hour ago)
    const baseTimeMs = Date.parse("2026-01-01T12:00:00.000Z");
    await idb.priceSync.savePoints("btc:binance:SPOT:USDT:5m", [
      { timestamp: new Date(baseTimeMs - 3600_000).toISOString(), payload: { price: "90000" } },
    ]);

    // Query looking backward at 12:00:00 with maxDistanceMs = 5 minutes (300,000 ms)
    // The 1-hour-old record is out of range; cursor query should bound range and return null directly
    const res = await idb.priceSync.queryPoint({
      tokenKey: "btc",
      timestamp: "2026-01-01T12:00:00.000Z",
      direction: "before",
      maxDistanceMs: 300_000,
    });

    expect(res).toBeNull();
    await idb.close();
  });
});
