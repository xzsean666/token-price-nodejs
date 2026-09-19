import zlib from "node:zlib";
import type { ArchiveProviderAdapter } from "./ArchiveProviderAdapter";
import type { KlinePoint } from "../domain/klineModels";

export class BinanceArchiveAdapter implements ArchiveProviderAdapter {
  readonly provider = "binance" as const;

  getMonthlyArchiveUrl(symbol: string, interval: string, year: number, month: number): string {
    const pair = symbol.toUpperCase().endsWith("USDT") ? symbol.toUpperCase() : `${symbol.toUpperCase()}USDT`;
    const mm = String(month).padStart(2, "0");
    return `https://data.binance.vision/data/spot/monthly/klines/${pair}/${interval}/${pair}-${interval}-${year}-${mm}.zip`;
  }

  parseArchive(rawData: Buffer | Uint8Array): KlinePoint[] {
    const csvContent = extractSingleFileFromZip(rawData);
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

/**
 * Decompresses the first file inside a ZIP buffer synchronously.
 */
function extractSingleFileFromZip(buf: Buffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length < 30) {
    throw new Error("Invalid ZIP archive: buffer too small.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sig = view.getUint32(0, true);
  if (sig !== 0x04034b50) {
    throw new Error(`Invalid ZIP signature: 0x${sig.toString(16)}`);
  }

  const compMethod = view.getUint16(8, true);
  const compSize = view.getUint32(18, true);
  const fileNameLen = view.getUint16(26, true);
  const extraLen = view.getUint16(28, true);
  const dataStart = 30 + fileNameLen + extraLen;

  let compressedData: Uint8Array;
  if (compSize > 0) {
    compressedData = bytes.subarray(dataStart, dataStart + compSize);
  } else {
    // If compressed size is 0 in local header, extract until central directory signature 0x02014b50
    let centralIdx = -1;
    for (let i = dataStart; i < bytes.length - 4; i++) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x01 && bytes[i + 3] === 0x02) {
        centralIdx = i;
        break;
      }
    }
    compressedData = centralIdx !== -1 ? bytes.subarray(dataStart, centralIdx) : bytes.subarray(dataStart);
  }

  if (compMethod === 8) {
    return zlib.inflateRawSync(compressedData).toString("utf-8");
  } else if (compMethod === 0) {
    // Stored (no compression)
    return new TextDecoder("utf-8").decode(compressedData);
  } else {
    throw new Error(`Unsupported ZIP compression method: ${compMethod}`);
  }
}
