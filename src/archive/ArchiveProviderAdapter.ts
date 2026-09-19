import type { KlinePoint } from "../domain/klineModels";

export interface ArchiveProviderAdapter {
  readonly provider: "binance" | "gate";

  /**
   * Constructs the monthly archive package URL.
   * @param symbol Clean base token or trading pair (e.g. BTC or BTC_USDT)
   * @param interval Kline interval (e.g. 5m, 1h, 1d)
   * @param year 4-digit year (e.g. 2024)
   * @param month 1-indexed month (1..12)
   */
  getMonthlyArchiveUrl(symbol: string, interval: string, year: number, month: number): string;

  /**
   * Decompresses and parses the raw archive package into canonical KlinePoint items.
   * @param rawData Raw downloaded buffer (ZIP or GZ)
   * @param interval Kline interval
   */
  parseArchive(rawData: Buffer | Uint8Array, interval: string): Promise<KlinePoint[]> | KlinePoint[];
}
