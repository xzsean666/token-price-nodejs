import type { KlinePoint } from "../domain/klineModels";

export const KLINE_RECORD_SIZE = 16; // 8 bytes timestamp_ms (UInt64LE) + 8 bytes price_usd (DoubleLE)

export class KlineBinaryCodec {
  /**
   * Serializes an array of KlinePoint items into a contiguous 16-byte fixed-length binary Uint8Array.
   */
  static encode(points: readonly KlinePoint[]): Uint8Array {
    // Sort ascending by timestamp and deduplicate
    const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp);
    const deduped: KlinePoint[] = [];
    let lastTs = -1;
    for (const p of sorted) {
      if (p.timestamp !== lastTs) {
        deduped.push(p);
        lastTs = p.timestamp;
      }
    }

    const bytes = new Uint8Array(deduped.length * KLINE_RECORD_SIZE);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    for (let i = 0; i < deduped.length; i++) {
      const offset = i * KLINE_RECORD_SIZE;
      const point = deduped[i]!;
      view.setBigUint64(offset, BigInt(point.timestamp), true);
      view.setFloat64(offset + 8, Number(point.priceUsd), true);
    }
    return bytes;
  }

  /**
   * Decodes a binary buffer into KlinePoint[], optionally slicing by [startMs, endMs) using O(log N) binary search.
   */
  static decode(data: Uint8Array | ArrayBuffer, startMs?: number, endMs?: number): KlinePoint[] {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const totalRecords = Math.floor(bytes.byteLength / KLINE_RECORD_SIZE);
    if (totalRecords === 0) return [];

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    let startIndex = 0;
    let endIndex = totalRecords;

    if (startMs !== undefined) {
      startIndex = this.binarySearchLower(view, totalRecords, BigInt(startMs));
    }
    if (endMs !== undefined) {
      endIndex = this.binarySearchLower(view, totalRecords, BigInt(endMs));
    }

    const count = Math.max(0, endIndex - startIndex);
    const points: KlinePoint[] = new Array(count);

    for (let i = 0; i < count; i++) {
      const offset = (startIndex + i) * KLINE_RECORD_SIZE;
      const timestamp = Number(view.getBigUint64(offset, true));
      const priceNum = view.getFloat64(offset + 8, true);
      points[i] = {
        timestamp,
        priceUsd: formatPrice(priceNum),
      };
    }

    return points;
  }

  /**
   * Finds the first record whose timestamp >= targetTs (lower_bound).
   */
  private static binarySearchLower(view: DataView, totalRecords: number, targetTs: bigint): number {
    let low = 0;
    let high = totalRecords;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const midTs = view.getBigUint64(mid * KLINE_RECORD_SIZE, true);
      if (midTs < targetTs) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }
}

function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const str = String(value);
  if (!str.includes("e") && !str.includes("E")) return str;
  return value.toFixed(18).replace(/\.?0+$/, "");
}
