import type { ArchiveProviderAdapter } from "./ArchiveProviderAdapter";
import type { KlinePoint } from "../domain/klineModels";
import { decompressZipSingleFile } from "../transport/decompression";

export class BinanceArchiveAdapter implements ArchiveProviderAdapter {
  readonly provider = "binance" as const;

  getMonthlyArchiveUrl(symbol: string, interval: string, year: number, month: number): string {
    const clean = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const pair = clean.endsWith("USDT") ? clean : `${clean}USDT`;
    const cleanInterval = interval.toLowerCase().replace(/[^a-z0-9]/g, "");
    const mm = String(month).padStart(2, "0");
    return `https://data.binance.vision/data/spot/monthly/klines/${pair}/${cleanInterval}/${pair}-${cleanInterval}-${year}-${mm}.zip`;
  }

  async parseArchive(rawData: Buffer | Uint8Array): Promise<KlinePoint[]> {
    const decompressedBytes = await decompressZipSingleFile(rawData);
    const csvContent = new TextDecoder("utf-8").decode(decompressedBytes);
    const lines = csvContent.split("\n");
    const points: KlinePoint[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const cols = trimmed.split(",");
      if (cols.length < 5) continue;

      const timestamp = Number(cols[0]);
      const close = cols[4];

      // Validate numeric timestamp and price
      if (Number.isSafeInteger(timestamp) && timestamp > 0 && typeof close === "string") {
        const priceNum = Number(close);
        if (Number.isFinite(priceNum) && priceNum > 0) {
          points.push({
            timestamp,
            priceUsd: close,
          });
        }
      }
    }

    return points;
  }
}
