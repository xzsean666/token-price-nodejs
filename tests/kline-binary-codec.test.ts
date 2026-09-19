import { describe, expect, it } from "vitest";
import { KlineBinaryCodec, KLINE_RECORD_SIZE } from "../src/archive/KlineBinaryCodec";
import type { KlinePoint } from "../src/domain/klineModels";

describe("KlineBinaryCodec", () => {
  it("encodes and decodes kline points correctly", () => {
    const points: KlinePoint[] = [
      { timestamp: 1704067200000, priceUsd: "42397.23" },
      { timestamp: 1704067500000, priceUsd: "42409.96" },
      { timestamp: 1704067800000, priceUsd: "42488" },
    ];

    const buffer = KlineBinaryCodec.encode(points);
    expect(buffer.length).toBe(3 * KLINE_RECORD_SIZE);

    const decoded = KlineBinaryCodec.decode(buffer);
    expect(decoded.length).toBe(3);
    expect(decoded[0]).toEqual({ timestamp: 1704067200000, priceUsd: "42397.23" });
    expect(decoded[1]).toEqual({ timestamp: 1704067500000, priceUsd: "42409.96" });
    expect(decoded[2]).toEqual({ timestamp: 1704067800000, priceUsd: "42488" });
  });

  it("deduplicates and sorts timestamps ascending during encoding", () => {
    const points: KlinePoint[] = [
      { timestamp: 1704067800000, priceUsd: "42488" },
      { timestamp: 1704067200000, priceUsd: "42397.23" },
      { timestamp: 1704067500000, priceUsd: "42409.96" },
      { timestamp: 1704067500000, priceUsd: "42409.96" }, // duplicate
    ];

    const buffer = KlineBinaryCodec.encode(points);
    expect(buffer.length).toBe(3 * KLINE_RECORD_SIZE);

    const decoded = KlineBinaryCodec.decode(buffer);
    expect(decoded.map((p) => p.timestamp)).toEqual([
      1704067200000,
      1704067500000,
      1704067800000,
    ]);
  });

  it("supports O(log N) binary search slicing with startMs and endMs", () => {
    const points: KlinePoint[] = [
      { timestamp: 1000, priceUsd: "10" },
      { timestamp: 2000, priceUsd: "20" },
      { timestamp: 3000, priceUsd: "30" },
      { timestamp: 4000, priceUsd: "40" },
      { timestamp: 5000, priceUsd: "50" },
    ];
    const buffer = KlineBinaryCodec.encode(points);

    // Exact slice [2000, 4000) -> 2000, 3000
    const slice1 = KlineBinaryCodec.decode(buffer, 2000, 4000);
    expect(slice1.map((p) => p.timestamp)).toEqual([2000, 3000]);

    // Non-exact slice [1500, 4500) -> 2000, 3000, 4000
    const slice2 = KlineBinaryCodec.decode(buffer, 1500, 4500);
    expect(slice2.map((p) => p.timestamp)).toEqual([2000, 3000, 4000]);

    // Out of range (before)
    const sliceBefore = KlineBinaryCodec.decode(buffer, 100, 500);
    expect(sliceBefore.length).toBe(0);

    // Out of range (after)
    const sliceAfter = KlineBinaryCodec.decode(buffer, 6000, 7000);
    expect(sliceAfter.length).toBe(0);
  });

  it("handles empty buffers gracefully", () => {
    const empty = KlineBinaryCodec.decode(new Uint8Array(0));
    expect(empty).toEqual([]);
  });
});
