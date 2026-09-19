# token-price-sdk

Universal, isomorphic CEX & DEX token price SDK for Node.js and Browser environments.

Designed to work cross-platform just like `evm-call`, featuring multi-exchange price aggregation, monthly kline binary archives, token support verification with negative caching, and dual-driver storage (SQLite in Node.js, native IndexedDB in browsers, plus an in-memory driver).

## Features

- **Isomorphic Architecture**: Runs seamlessly in Node.js (v20+) and modern web browsers.
- **Dual-Storage Engine**:
  - **Backend (Node.js)**: Built-in SQLite storage powered by native `node:sqlite` (zero native-compilation dependencies) or pluggable SQL adapters.
  - **Frontend (Browser)**: Native IndexedDB storage with compound index cursor traversal for $O(\log N)$ directional timestamp queries (`before`, `after`, `nearest`).
  - **In-Memory**: High-speed memory driver for testing, SSR, or ephemeral environments.
- **Isomorphic HTTP Transport**:
  - `AxiosHttpTransport`: Default for Node.js environments.
  - `FetchHttpTransport`: Zero-dependency fetch-based transport for browsers, Edge runtimes, and Cloudflare Workers.
- **Isomorphic Decompression**:
  - Native `DecompressionStream` for Gzip and Deflate decompression in modern browsers and Node.js.
  - Handles Binance PKZip single-file decompression and Gate `.csv.gz` stream extraction directly in memory.
- **Multi-Exchange Price Aggregation**:
  - Supported providers: Binance, Gate.io, OKX, Coinbase, GeckoTerminal (DEX).
  - Configurable routing, timeouts, fallback cascade, and concurrency limits.
- **Monthly Kline Binary Codec**:
  - Compact 16-byte fixed-width binary encoding (`DataView` based) for ultra-fast kline caching and binary search timestamp slicing.
- **Token Support Store & Negative Caching**:
  - Memory -> Storage -> Upstream probe lookup cascade.
  - Negative caching for confirmed non-existent tokens with 24-hour TTL, protecting upstream rate limits.
  - Preserves retries on network timeouts and 5xx errors without negative poisoning.

## Installation

```bash
pnpm add token-price-sdk
```

## Quick Start

### Basic Client Usage

```typescript
import { createTokenPriceClient } from "token-price-sdk";

// Create client with automatic storage selection (IndexedDB in browser, SQLite/Memory in Node.js)
const client = createTokenPriceClient();
await client.initialize();

// Query price history across exchanges
const prices = await client.getPriceHistory({
  token: "Ethereum",
  range: { kind: "date", date: "2026-06-01" },
});

// Query 5-minute historical klines
const klines = await client.getKlines({
  token: "BTC",
  quote: "USDT",
  start: "2026-01-01T00:00:00.000Z",
  end: "2026-01-02T00:00:00.000Z",
});

// Check exchange support
const supported = await client.isTokenSupported("ETH", "binance");
```

### Storage Drivers

```typescript
import {
  createPriceStorage,
  SqlitePriceStorage,
  IndexedDbPriceStorage,
  MemoryPriceStorage,
} from "token-price-sdk";

// Automatic detection:
const storage = createPriceStorage({ driver: "auto" });

// Explicit SQLite (Node.js):
const sqliteStorage = new SqlitePriceStorage({ path: "./data/prices.db" });

// Explicit IndexedDB (Browser):
const idbStorage = new IndexedDbPriceStorage({ dbName: "my-app-prices" });

// Explicit In-Memory:
const memStorage = new MemoryPriceStorage();
```

## License

MIT
