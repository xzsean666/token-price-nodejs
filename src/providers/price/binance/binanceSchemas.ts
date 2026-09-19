import { z } from "zod";

export const binanceExchangeInfoSchema = z.object({
  symbols: z.array(z.object({ symbol: z.string(), status: z.string(), isSpotTradingAllowed: z.boolean().optional() }).passthrough()),
}).passthrough();

export const binanceKlinesSchema = z.array(z.array(z.union([z.string(), z.number(), z.null()])).min(6));
export type BinanceKline = z.infer<typeof binanceKlinesSchema>[number];
