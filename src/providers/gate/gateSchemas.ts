import { z } from "zod";

export const gateCurrencyPairSchema = z.object({
  id: z.string(),
  base: z.string(),
  quote: z.string(),
  trade_status: z.string(),
}).passthrough();

export const gateCandlesSchema = z.array(
  z.array(z.string()).min(6),
);
