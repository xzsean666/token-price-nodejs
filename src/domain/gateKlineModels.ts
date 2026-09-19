import { tokenPriceError } from "./errors";

export interface GateKlinePoint {
  readonly timestamp: number;
  readonly priceUsd: string;
}

export interface GateKlineRequest {
  readonly pair: string;
  readonly interval?: "5m" | "1h" | "1d" | undefined;
  readonly start: number;
  readonly end: number;
  readonly signal?: AbortSignal | undefined;
}

export interface NormalizedGateKlineRequest {
  readonly pair: string;
  readonly interval: "5m" | "1h" | "1d";
  readonly start: number;
  readonly end: number;
  readonly signal?: AbortSignal | undefined;
}

export function normalizeGateKlineRequest(request: GateKlineRequest): NormalizedGateKlineRequest {
  const pair = request.pair.trim().toUpperCase();
  if (!pair) {
    throw tokenPriceError("TOKEN_NOT_FOUND", "pair is required.");
  }
  if (!request.start || !request.end || request.start >= request.end) {
    throw tokenPriceError("PRICE_RANGE_INVALID", "start must be strictly earlier than end.");
  }
  return {
    pair,
    interval: request.interval ?? "5m",
    start: request.start,
    end: request.end,
    ...(request.signal ? { signal: request.signal } : {}),
  };
}
