import { z } from "zod";

export const coinbaseProductsSchema = z.array(
  z.object({
    id: z.string(),
    status: z.string().optional(),
    trading_disabled: z.boolean().optional(),
    cancel_only: z.boolean().optional(),
    post_only: z.boolean().optional(),
  }).passthrough(),
);

export const coinbaseCandlesSchema = z.array(z.array(z.union([z.string(), z.number()])).min(6));
export type CoinbaseCandle = z.infer<typeof coinbaseCandlesSchema>[number];
