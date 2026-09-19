import axios from "axios";
import type { KlinePoint } from "../domain/klineModels";
import { KlineBinaryCodec } from "./KlineBinaryCodec";
import type { ArchiveProviderAdapter } from "./ArchiveProviderAdapter";
import { BinanceArchiveAdapter } from "./BinanceArchiveAdapter";
import { GateArchiveAdapter } from "./GateArchiveAdapter";
import { TokenPriceError } from "../domain/errors";
import type { PriceStorage } from "../storage/PriceStorage";
import type { HttpTransport } from "../transport/HttpTransport";

export interface KlineArchiveManagerOptions {
  readonly cacheDir?: string | undefined;
  readonly ttlMs?: number | undefined; // Default: 24h = 86_400_000 ms
  readonly storage?: PriceStorage | null | undefined;
  readonly axiosInstance?: any | undefined;
  readonly transport?: HttpTransport | undefined;
}

class AsyncLock {
  private queue: Promise<void> = Promise.resolve();

  acquire<T>(fn: () => Promise<T>): Promise<T> {
    const res = this.queue.then(fn);
    this.queue = res.then(() => {}, () => {});
    return res;
  }
}

let nodeFsModule: typeof import("node:fs") | null = null;
let nodePathModule: typeof import("node:path") | null = null;

async function getNodeFs(): Promise<{ fs: typeof import("node:fs"); path: typeof import("node:path") } | null> {
  if (typeof process === "undefined" || !process.versions?.node) {
    return null;
  }
  if (!nodeFsModule || !nodePathModule) {
    try {
      const [fs, path] = await Promise.all([import("node:fs"), import("node:path")]);
      nodeFsModule = (fs as any).default ?? fs;
      nodePathModule = (path as any).default ?? path;
    } catch {
      return null;
    }
  }
  return { fs: nodeFsModule!, path: nodePathModule! };
}

export class KlineArchiveManager {
  private readonly cacheDir: string | null;
  private readonly ttlMs: number;
  private readonly storage: PriceStorage | null;
  private readonly axiosClient: typeof axios;
  private readonly transport: HttpTransport | null;
  private readonly lock = new AsyncLock();
  private readonly adapters = new Map<"binance" | "gate", ArchiveProviderAdapter>([
    ["binance", new BinanceArchiveAdapter()],
    ["gate", new GateArchiveAdapter()],
  ]);

  constructor(options: KlineArchiveManagerOptions = {}) {
    this.cacheDir = options.cacheDir ?? "./data/cache/klines";
    this.ttlMs = options.ttlMs ?? 86_400_000; // 1 day
    this.storage = options.storage ?? null;
    this.axiosClient = options.axiosInstance ?? axios;
    this.transport = options.transport ?? null;
  }

  /**
   * Retrieves kline points for a completed calendar month.
   * If cached and within 1-day TTL, reads directly from cache.
   * Otherwise, downloads the archive package (with single concurrency lock), converts to .bin, and caches.
   */
  async getMonthlyKlines(
    provider: "binance" | "gate",
    symbol: string,
    interval: string,
    year: number,
    month: number,
    startMs?: number,
    endMs?: number,
    signal?: AbortSignal,
  ): Promise<KlinePoint[]> {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new TokenPriceError({
        code: "UNSUPPORTED_OPERATION",
        message: `Archive provider "${provider}" is not supported.`,
        retryable: false,
        provider,
      });
    }

    const cleanSymbol = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const baseSymbol = cleanSymbol.endsWith("USDT") ? cleanSymbol.slice(0, -4) : cleanSymbol;
    const mm = String(month).padStart(2, "0");
    const cacheKey = `${provider}/${baseSymbol}/${interval}/${year}-${mm}`;

    // 1. Fast path: check storage or disk cache
    const cachedData = await this.readCache(cacheKey);
    if (cachedData) {
      return KlineBinaryCodec.decode(cachedData, startMs, endMs);
    }

    // 2. Slow path: Acquire single-concurrency lock to download and encode
    return this.lock.acquire(async () => {
      // Re-check cache after acquiring lock
      const recheck = await this.readCache(cacheKey);
      if (recheck) {
        return KlineBinaryCodec.decode(recheck, startMs, endMs);
      }

      if (signal?.aborted) {
        throw new TokenPriceError({
          code: "REQUEST_ABORTED",
          message: "Kline archive download was aborted.",
          retryable: false,
          provider,
        });
      }

      const url = adapter.getMonthlyArchiveUrl(baseSymbol, interval, year, month);
      let rawBuffer: Uint8Array;
      try {
        if (this.transport) {
          const res = await this.transport.request<ArrayBuffer | Uint8Array>({
            method: "GET",
            url,
            responseType: "arraybuffer",
            timeoutMs: 60_000,
            ...(signal === undefined ? {} : { signal }),
          });
          if (res.status !== 200 || !res.body) {
            throw new Error(`HTTP ${res.status}`);
          }
          rawBuffer = res.body instanceof Uint8Array ? res.body : new Uint8Array(res.body);
        } else {
          const res = await this.axiosClient.get(url, {
            responseType: "arraybuffer",
            timeout: 60_000,
            ...(signal === undefined ? {} : { signal }),
          });
          rawBuffer = res.data instanceof Uint8Array ? res.data : new Uint8Array(res.data);
        }
      } catch (error: any) {
        if (signal?.aborted) {
          throw new TokenPriceError({
            code: "REQUEST_ABORTED",
            message: "Kline archive download was aborted.",
            retryable: false,
            provider,
          });
        }
        throw new TokenPriceError({
          code: "PROVIDER_UNAVAILABLE",
          message: `Failed to download kline archive from ${provider} for ${baseSymbol} ${year}-${mm}.`,
          retryable: true,
          provider,
          cause: error,
        });
      }

      // Parse and normalize into points
      const points = await adapter.parseArchive(rawBuffer, interval);

      // Encode to compact 16-byte fixed-length binary
      const binaryData = KlineBinaryCodec.encode(points);

      // Write to cache
      await this.writeCache(cacheKey, binaryData);

      // Clean expired files (fire and forget)
      this.cleanExpiredCache().catch(() => undefined);

      return KlineBinaryCodec.decode(binaryData, startMs, endMs);
    });
  }

  private async readCache(cacheKey: string): Promise<Uint8Array | null> {
    // 1. Try disk cache if in Node.js
    const nodeFs = await getNodeFs();
    if (this.cacheDir && nodeFs) {
      try {
        const filePath = nodeFs.path.join(this.cacheDir, `${cacheKey}.bin`);
        if (nodeFs.fs.existsSync(filePath)) {
          const stat = nodeFs.fs.statSync(filePath);
          if (Date.now() - stat.mtimeMs < this.ttlMs) {
            const buf = nodeFs.fs.readFileSync(filePath);
            return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
          }
        }
      } catch {
        // Fall through
      }
    }

    // 2. Try storage archive cache
    if (this.storage) {
      return this.storage.archiveCache.getArchive(cacheKey, this.ttlMs);
    }

    return null;
  }

  private async writeCache(cacheKey: string, data: Uint8Array): Promise<void> {
    const nodeFs = await getNodeFs();
    if (this.cacheDir && nodeFs) {
      try {
        const filePath = nodeFs.path.join(this.cacheDir, `${cacheKey}.bin`);
        nodeFs.fs.mkdirSync(nodeFs.path.dirname(filePath), { recursive: true });
        nodeFs.fs.writeFileSync(filePath, data);
      } catch {
        // Disk write failure non-fatal
      }
    }

    if (this.storage) {
      await this.storage.archiveCache.setArchive(cacheKey, data).catch(() => undefined);
    }
  }

  /**
   * Cleans up cache files older than TTL (24 hours).
   */
  async cleanExpiredCache(): Promise<void> {
    const nodeFs = await getNodeFs();
    if (this.cacheDir && nodeFs) {
      try {
        if (nodeFs.fs.existsSync(this.cacheDir)) {
          cleanDir(nodeFs.fs, nodeFs.path, this.cacheDir, Date.now(), this.ttlMs);
        }
      } catch {
        // Ignore
      }
    }

    if (this.storage) {
      await this.storage.archiveCache.cleanExpired(this.ttlMs).catch(() => undefined);
    }
  }
}

function cleanDir(fs: typeof import("node:fs"), path: typeof import("node:path"), dir: string, now: number, ttlMs: number): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      cleanDir(fs, path, fullPath, now, ttlMs);
      try {
        if (fs.readdirSync(fullPath).length === 0) {
          fs.rmdirSync(fullPath);
        }
      } catch {}
    } else if (entry.isFile() && entry.name.endsWith(".bin")) {
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > ttlMs) {
          fs.unlinkSync(fullPath);
        }
      } catch {}
    }
  }
}
