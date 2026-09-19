import type { TokenPricePoint, TokenPriceProviderResult } from "../../domain/priceModels";
import { datesInclusive, decimalText, utcDateFromMilliseconds } from "../../domain/priceOperations";
import type { NormalizedTokenPriceRequest } from "../../domain/priceOperations";
import type { GeckoPool, GeckoToken } from "./geckoTerminalSchemas";

export interface GeckoResolution {
  readonly network: string;
  readonly tokenAddress: string;
  readonly poolAddress: string;
  readonly symbol: string;
  readonly name: string | null;
  readonly tokenSide: "base" | "quote";
}

interface Candidate extends GeckoResolution {
  readonly liquidity: string;
  readonly volume: string;
  readonly rank: 1 | 2 | 3;
}

export function resolveGeckoPool(
  pools: readonly GeckoPool[],
  tokens: readonly GeckoToken[],
  request: NormalizedTokenPriceRequest,
  networks: readonly string[],
): GeckoResolution {
  const tokenById = new Map(tokens.map((token) => [token.id, token]));
  const candidates: Candidate[] = [];
  for (const pool of pools) {
    const network = pool.relationships.network.data?.id;
    if (network === undefined || !networks.includes(network)) continue;
    const poolAddress = pool.attributes.address ?? addressFromIdentifier(pool.id);
    if (poolAddress === null) continue;
    for (const side of ["base", "quote"] as const) {
      const tokenId = pool.relationships[(side + "_token") as "base_token" | "quote_token"].data?.id;
      const token = tokenId === undefined ? undefined : tokenById.get(tokenId);
      if (token === undefined) continue;
      const symbol = token.attributes.symbol?.trim();
      const name = token.attributes.name?.trim();
      const rank = matchRank(request.normalizedToken, symbol, name);
      if (rank === null) continue;
      candidates.push({
        network,
        tokenAddress: token.attributes.address.toLowerCase(),
        poolAddress: poolAddress.toLowerCase(),
        symbol: symbol ?? request.baseSymbol,
        name: name === undefined || name === "" ? null : name,
        tokenSide: side,
        liquidity: decimalMetric(pool.attributes.reserve_in_usd),
        volume: decimalMetric(pool.attributes.volume_usd?.h24),
        rank,
      });
    }
  }
  if (candidates.length === 0) throw new Error("TOKEN_NOT_FOUND");
  const bestRank = Math.min(...candidates.map((candidate) => candidate.rank));
  const best = candidates.filter((candidate) => candidate.rank === bestRank);
  const tokenKeys = new Set(best.map((candidate) => candidate.network + ":" + candidate.tokenAddress));
  if (tokenKeys.size !== 1) throw new Error("TOKEN_AMBIGUOUS");
  best.sort(
    (left, right) =>
      compareDecimal(right.liquidity, left.liquidity) ||
      compareDecimal(right.volume, left.volume) ||
      left.poolAddress.localeCompare(right.poolAddress),
  );
  const selected = best[0];
  if (selected === undefined) throw new Error("TOKEN_NOT_FOUND");
  return Object.freeze({
    network: selected.network,
    tokenAddress: selected.tokenAddress,
    poolAddress: selected.poolAddress,
    symbol: selected.symbol,
    name: selected.name,
    tokenSide: selected.tokenSide,
  });
}

export function mapGeckoOhlcv(
  rows: readonly (readonly (string | number)[])[],
  request: NormalizedTokenPriceRequest,
  nowMs: number,
): readonly TokenPricePoint[] {
  const points = new Map<string, TokenPricePoint>();
  const today = utcDateFromMilliseconds(nowMs);
  for (const row of rows) {
    const seconds = row[0];
    const open = decimalText(row[1]);
    const high = decimalText(row[2]);
    const low = decimalText(row[3]);
    const close = decimalText(row[4]);
    const volume = decimalText(row[5]);
    if (
      typeof seconds !== "number" ||
      !Number.isSafeInteger(seconds) ||
      seconds < 0 ||
      open === null ||
      high === null ||
      low === null ||
      close === null ||
      volume === null
    ) {
      throw new Error("Invalid GeckoTerminal daily candle.");
    }
    const milliseconds = seconds * 1_000;
    const date = utcDateFromMilliseconds(milliseconds);
    if (date < request.resolvedRange.startDate || date > request.resolvedRange.endDate) continue;
    points.set(
      date,
      Object.freeze({
        date,
        timestamp: new Date(milliseconds).toISOString(),
        open,
        high,
        low,
        close,
        price: close,
        volume,
        isFinal: date < today,
      }),
    );
  }
  return Object.freeze([...points.values()].sort((left, right) => left.date.localeCompare(right.date)));
}

export function geckoResult(
  request: NormalizedTokenPriceRequest,
  resolution: GeckoResolution,
  points: readonly TokenPricePoint[],
): TokenPriceProviderResult {
  const present = new Set(points.map((point) => point.date));
  return Object.freeze({
    provider: "geckoterminal",
    status: "success",
    token: Object.freeze({
      input: request.tokenInput,
      normalized: request.normalizedToken,
      symbol: resolution.symbol,
      name: resolution.name,
    }),
    market: Object.freeze({
      product: resolution.poolAddress,
      quoteAsset: "USD",
      sourceKind: "onchain",
      network: resolution.network,
      tokenAddress: resolution.tokenAddress,
      poolAddress: resolution.poolAddress,
    }),
    interval: "1d",
    timezone: "UTC",
    requestedRange: request.resolvedRange,
    points,
    missingDates: Object.freeze(
      datesInclusive(request.resolvedRange.startDate, request.resolvedRange.endDate).filter((date) => !present.has(date)),
    ),
  });
}

function matchRank(input: string, symbol: string | undefined, name: string | undefined): 1 | 2 | 3 | null {
  const normalizedSymbol = symbol?.toLowerCase();
  const normalizedName = name?.toLowerCase();
  if (normalizedSymbol === input) return 1;
  if (normalizedName === input) return 2;
  if ((normalizedSymbol?.startsWith(input) ?? false) || (normalizedName?.startsWith(input) ?? false)) return 3;
  return null;
}

function decimalMetric(value: string | number | undefined): string {
  return decimalText(value) ?? "0";
}

function compareDecimal(left: string, right: string): number {
  const [leftInteger, leftFraction = ""] = left.split(".");
  const [rightInteger, rightFraction = ""] = right.split(".");
  const normalizedLeftInteger = (leftInteger ?? "0").replace(/^0+(?=\d)/, "");
  const normalizedRightInteger = (rightInteger ?? "0").replace(/^0+(?=\d)/, "");
  if (normalizedLeftInteger.length !== normalizedRightInteger.length) {
    return normalizedLeftInteger.length > normalizedRightInteger.length ? 1 : -1;
  }
  if (normalizedLeftInteger !== normalizedRightInteger) {
    return normalizedLeftInteger > normalizedRightInteger ? 1 : -1;
  }
  const fractionLength = Math.max(leftFraction.length, rightFraction.length);
  const normalizedLeftFraction = leftFraction.padEnd(fractionLength, "0");
  const normalizedRightFraction = rightFraction.padEnd(fractionLength, "0");
  if (normalizedLeftFraction === normalizedRightFraction) return 0;
  return normalizedLeftFraction > normalizedRightFraction ? 1 : -1;
}

function addressFromIdentifier(value: string): string | null {
  const separator = value.indexOf("_");
  return separator === -1 ? null : value.slice(separator + 1);
}
