import { z } from "zod";
import { invalidRequest } from "./errors";
import type { ResolvedTokenPriceRange } from "./priceModels";

export type TokenPriceRange =
  | { readonly kind: "latest"; readonly days: number }
  | { readonly kind: "date"; readonly date: string }
  | { readonly kind: "between"; readonly startDate: string; readonly endDate: string };

export interface TokenPriceHistoryRequest {
  readonly token: string;
  readonly range: TokenPriceRange;
  readonly signal?: AbortSignal | undefined;
}

export interface NormalizedTokenPriceRequest {
  readonly operation: "getPriceHistory";
  readonly tokenInput: string;
  readonly normalizedToken: string;
  readonly baseSymbol: string;
  readonly range: TokenPriceRange;
  readonly resolvedRange: ResolvedTokenPriceRange;
  readonly signal?: AbortSignal | undefined;
}

export interface TokenPriceNormalizationOptions {
  readonly aliases?: Readonly<Record<string, string>> | undefined;
  readonly now?: Date | undefined;
}

export const BUILTIN_TOKEN_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  eth: "ETH",
  ethereum: "ETH",
  btc: "BTC",
  bitcoin: "BTC",
});

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const requestSchema = z.object({
  token: z.string().trim().min(1).max(128),
  range: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("latest"), days: z.number().int().min(1).max(365) }).strict(),
    z.object({ kind: z.literal("date"), date: dateSchema }).strict(),
    z.object({ kind: z.literal("between"), startDate: dateSchema, endDate: dateSchema }).strict(),
  ]),
  signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal).optional(),
}).strict();

export function normalizeTokenPriceHistoryRequest(
  input: unknown,
  options: TokenPriceNormalizationOptions = {},
): NormalizedTokenPriceRequest {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidRequest("Invalid token price history request.");
  }
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw invalidRequest("The current time is invalid.");
  }
  const today = utcDateFromMilliseconds(now.getTime());
  const aliasLookup = { ...BUILTIN_TOKEN_ALIASES, ...(options.aliases ?? {}) };
  const normalizedInput = parsed.data.token.toLowerCase();
  const baseSymbol = (aliasLookup[normalizedInput] ?? parsed.data.token).trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,127}$/.test(baseSymbol)) {
    throw invalidRequest("Token aliases must resolve to a market symbol.");
  }
  const resolvedRange = resolveRange(parsed.data.range, today);
  return Object.freeze({
    operation: "getPriceHistory",
    tokenInput: parsed.data.token,
    normalizedToken: normalizedInput,
    baseSymbol,
    range: Object.freeze(parsed.data.range),
    resolvedRange,
    ...(parsed.data.signal === undefined ? {} : { signal: parsed.data.signal }),
  });
}

export const parseTokenPriceHistoryRequest = normalizeTokenPriceHistoryRequest;

export function utcDateFromMilliseconds(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

export function utcStartMilliseconds(date: string): number {
  const parsed = parseUtcDate(date);
  return Date.UTC(parsed.year, parsed.month - 1, parsed.day);
}

export function addUtcDays(date: string, days: number): string {
  return utcDateFromMilliseconds(utcStartMilliseconds(date) + days * 86_400_000);
}

export function datesInclusive(startDate: string, endDate: string): string[] {
  const result: string[] = [];
  for (let value = startDate; value <= endDate; value = addUtcDays(value, 1)) {
    result.push(value);
  }
  return result;
}

export function isDecimalString(value: string): boolean {
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}

export function decimalText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return isDecimalString(trimmed) ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    const rendered = String(value);
    return isDecimalString(rendered) ? rendered : null;
  }
  return null;
}

function resolveRange(range: TokenPriceRange, today: string): ResolvedTokenPriceRange {
  if (range.kind === "latest") {
    return Object.freeze({ kind: range.kind, startDate: addUtcDays(today, -(range.days - 1)), endDate: today });
  }
  if (range.kind === "date") {
    validateRequestedDate(range.date, today);
    return Object.freeze({ kind: range.kind, startDate: range.date, endDate: range.date });
  }
  validateRequestedDate(range.startDate, today);
  validateRequestedDate(range.endDate, today);
  if (range.startDate > range.endDate) {
    throw invalidRequest("startDate must not be after endDate.");
  }
  const length = Math.floor((utcStartMilliseconds(range.endDate) - utcStartMilliseconds(range.startDate)) / 86_400_000) + 1;
  if (length > 366) {
    throw invalidRequest("A token price range may contain at most 366 UTC dates.");
  }
  return Object.freeze({ kind: range.kind, startDate: range.startDate, endDate: range.endDate });
}

function validateRequestedDate(value: string, today: string): void {
  parseUtcDate(value);
  if (value > today) {
    throw invalidRequest("A token price date must not be in the future.");
  }
  const earliestYear = Number(today.slice(0, 4)) - 10;
  const earliest = String(earliestYear).padStart(4, "0") + today.slice(4);
  if (value < earliest) {
    throw invalidRequest("A token price date must not be more than ten years in the past.");
  }
}

function parseUtcDate(value: string): { year: number; month: number; day: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw invalidRequest("Dates must use UTC YYYY-MM-DD format.");
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const milliseconds = Date.UTC(year, month - 1, day);
  const date = new Date(milliseconds);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw invalidRequest("Dates must be real UTC calendar dates.");
  }
  return { year, month, day };
}
