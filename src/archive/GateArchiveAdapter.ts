import type { ArchiveProviderAdapter } from "./ArchiveProviderAdapter";
import type { KlinePoint } from "../domain/klineModels";

export class GateArchiveAdapter implements ArchiveProviderAdapter {
  readonly provider = "gate" as const;

  getMonthlyArchiveUrl(symbol: string, interval: string, year: number, month: number): string {
    const clean = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const base = clean.endsWith("USDT") ? clean.slice(0, -4) : clean;
    const pair = `${base}_USDT`;
    const mm = String(month).padStart(2, "0");
    const yyyymm = `${year}${mm}`;
    return `https://download.gatedata.org/spot/candlesticks_${interval}/${yyyymm}/${pair}-${yyyymm}.csv.gz`;
  }

  parseArchive(rawData: Buffer | Uint8Array, interval: string): KlinePoint[] {
    let decompressed: string;
    if (typeof process !== "undefined" && process.versions?.node) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const zlib = require("node:zlib");
        decompressed = zlib.gunzipSync(rawData).toString("utf-8");
      } catch (err) {
        throw new Error(`Failed to gunzip Gate archive: ${err}`);
      }
    } else {
      throw new Error("Synchronous gunzip decompression requires Node.js zlib.");
    }

    const lines = decompressed.split("\n");
    const points: KlinePoint[] = [];

    // Gate column order: [timestampSec, volume, close, high, low, open]
    // 1h uses open (index 5), other intervals use close (index 2)
    const priceIndex = interval === "1h" ? 5 : 2;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const cols = trimmed.split(",");
      if (cols.length < 6) continue;

      const sec = Number(cols[0]);
      const priceStr = cols[priceIndex];

      if (Number.isSafeInteger(sec) && sec > 0 && typeof priceStr === "string") {
        const priceNum = Number(priceStr);
        if (Number.isFinite(priceNum) && priceNum > 0) {
          points.push({
            timestamp: sec * 1000,
            priceUsd: priceStr,
          });
        }
      }
    }

    return points;
  }
}
