import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { GateArchiveAdapter } from "../src/archive/GateArchiveAdapter";
import { BinanceArchiveAdapter } from "../src/archive/BinanceArchiveAdapter";
import { KlineArchiveManager } from "../src/archive/KlineArchiveManager";
import { decompressGzip, decompressZipSingleFile } from "../src/transport/decompression";
import { KlineBinaryCodec } from "../src/archive/KlineBinaryCodec";
import type { HttpTransport, HttpRequest, HttpResponse } from "../src/transport/HttpTransport";
import { MemoryPriceStorage } from "../src/storage/MemoryPriceStorage";

function createSimpleZip(filename: string, content: string): Uint8Array {
  const fileBytes = Buffer.from(content, "utf-8");
  const nameBytes = Buffer.from(filename, "utf-8");
  const compressed = zlib.deflateRawSync(fileBytes);

  // Local header: 30 bytes
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0, 6); // flags
  header.writeUInt16LE(8, 8); // compression method (8 = deflate)
  header.writeUInt16LE(0, 10); // time
  header.writeUInt16LE(0, 12); // date
  header.writeUInt32LE(0, 14); // crc32 (mock 0)
  header.writeUInt32LE(compressed.length, 18); // compressed size
  header.writeUInt32LE(fileBytes.length, 22); // uncompressed size
  header.writeUInt16LE(nameBytes.length, 26); // file name length
  header.writeUInt16LE(0, 28); // extra field length

  return Buffer.concat([header, nameBytes, compressed]);
}

describe("Archive Adapters & Isomorphic Decompression", () => {
  it("decompresses gzip and parses Gate archive correctly", async () => {
    const csvContent = [
      "1704067200,100.5,42100.25,42200,42000,42050",
      "1704070800,85.2,42300.50,42350,42100,42100",
    ].join("\n");

    const compressed = zlib.gzipSync(Buffer.from(csvContent, "utf-8"));
    const decompressed = await decompressGzip(compressed);
    expect(new TextDecoder().decode(decompressed)).toBe(csvContent);

    const adapter = new GateArchiveAdapter();
    const points = await adapter.parseArchive(compressed, "1d");
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({
      timestamp: 1704067200 * 1000,
      priceUsd: "42100.25",
    });
    expect(points[1]).toEqual({
      timestamp: 1704070800 * 1000,
      priceUsd: "42300.50",
    });
  });

  it("decompresses zip and parses Binance archive correctly", async () => {
    const csvContent = [
      "1704067200000,42050.0,42200.0,42000.0,42100.25,100.5",
      "1704070800000,42100.0,42350.0,42100.0,42300.50,85.2",
    ].join("\n");

    const zipBuffer = createSimpleZip("BTCUSDT-1d-2024-01.csv", csvContent);
    const decompressed = await decompressZipSingleFile(zipBuffer);
    expect(new TextDecoder().decode(decompressed)).toBe(csvContent);

    const adapter = new BinanceArchiveAdapter();
    const points = await adapter.parseArchive(zipBuffer);
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({
      timestamp: 1704067200000,
      priceUsd: "42100.25",
    });
    expect(points[1]).toEqual({
      timestamp: 1704070800000,
      priceUsd: "42300.50",
    });
  });

  it("integrates with KlineArchiveManager using custom HttpTransport", async () => {
    const csvContent = "1704067200,10.0,42500.0,42600.0,42400.0,42450.0\n";
    const compressed = zlib.gzipSync(Buffer.from(csvContent, "utf-8"));

    const mockTransport: HttpTransport = {
      async request<T = any>(req: HttpRequest): Promise<HttpResponse<T>> {
        return {
          status: 200,
          headers: {},
          body: compressed as unknown as T,
        };
      },
    };

    const storage = new MemoryPriceStorage();
    const manager = new KlineArchiveManager({
      transport: mockTransport,
      storage,
      cacheDir: undefined, // Disable disk cache to test pure memory/storage
    });

    const points = await manager.getMonthlyKlines("gate", "BTC", "1d", 2024, 1);
    expect(points).toHaveLength(1);
    expect(points[0]?.priceUsd).toBe("42500");

    // Second call should hit storage cache
    const cachedPoints = await manager.getMonthlyKlines("gate", "BTC", "1d", 2024, 1);
    expect(cachedPoints).toHaveLength(1);
    expect(cachedPoints[0]?.priceUsd).toBe("42500");
  });

  it("handles micro-prices with high precision in KlineBinaryCodec without losing precision", () => {
    const microPoints = [
      { timestamp: 1700000000000, priceUsd: "0.00000000123456" },
      { timestamp: 1700000060000, priceUsd: "0.00000005" },
    ];
    const encoded = KlineBinaryCodec.encode(microPoints);
    const decoded = KlineBinaryCodec.decode(encoded);

    expect(decoded).toHaveLength(2);
    expect(Number(decoded[0]?.priceUsd)).toBeCloseTo(0.00000000123456, 12);
    expect(decoded[0]?.priceUsd).not.toBe("0");
    expect(decoded[1]?.priceUsd).toBe("0.00000005");
  });
});
